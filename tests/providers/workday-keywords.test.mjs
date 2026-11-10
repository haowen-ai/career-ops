// tests/providers/workday-keywords.test.mjs — keyword search for big Workday
// boards (entry.keywords + entry.keyword_min_total → CXS `searchText`).
// No network — ctx.fetchJson is an in-memory stub keyed on the POST body.
//
// Run:  node --test tests/providers/workday-keywords.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/workday.mjs')).href);
const workday = mod.default;
const { resolveKeywords, chooseStudentFacet, resolveFacetValues, buildFacetValuesMatcher } = mod;

const ENTRY = { name: 'Acme', careers_url: 'https://acme.wd1.myworkdayjobs.com/acme' };

const postings = (tag, offset, n = 20) => Array.from({ length: n }, (_, i) => ({
  title: `${tag} job ${offset + i}`,
  externalPath: `/job/city/${tag}-${offset + i}_R${tag.toUpperCase()}${String(offset + i).padStart(4, '0')}`,
  postedOn: 'Posted Today',
}));

/**
 * Stub CXS: `boards` maps searchText → { total, n, facets?, overrides? }.
 * '' is the unfiltered board. Each query pages honestly over `n` postings.
 */
function makeCtx(boards) {
  const calls = [];
  const sleeps = [];
  const ctx = {
    transport: 'http',
    fetchText: async () => { throw new Error('fetchText should not be called'); },
    sleep: async (ms) => { sleeps.push(ms); },
    includeUndated: true,
    fetchJson: async (_url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body);
      const facetKey = Object.entries(body.appliedFacets || {}).map(([k, v]) => `${k}=${v}`).sort().join('&');
      const b = boards[facetKey ? `${body.searchText}|${facetKey}` : body.searchText];
      if (!b) throw new Error(`unexpected query ${JSON.stringify(body)}`);
      const remain = Math.max(0, Math.min(PAGE, b.n - body.offset));
      const res = { facets: b.facets || [], jobPostings: (b.make || postings)(b.tag ?? (body.searchText || 'all'), body.offset, remain) };
      if (b.total !== undefined) res.total = b.total;
      return res;
    },
  };
  return { ctx, calls, sleeps };
}
const PAGE = 20;
const quiet = async (fn) => {
  const orig = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = orig; }
};

test('resolveKeywords: absent / false / empty → []; trims and dedups', () => {
  assert.deepEqual(resolveKeywords({}), []);
  assert.deepEqual(resolveKeywords({ keywords: false }), []);
  assert.deepEqual(resolveKeywords({ keywords: [] }), []);
  assert.deepEqual(resolveKeywords({ keywords: [' intern ', 'Intern', '', 3, 'co-op'] }), ['intern', 'co-op']);
});

test('keywords absent → full board exactly as before, no searchText, no marker', async () => {
  const { ctx, calls } = makeCtx({ '': { total: 45, n: 45 } });
  const jobs = await workday.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 45);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.searchText === ''));
  assert.equal(jobs.keywordSearch, undefined);
  assert.equal(jobs.truncated, undefined);
});

test('keywords: false → full board', async () => {
  const { ctx, calls } = makeCtx({ '': { total: 25, n: 25 } });
  const jobs = await workday.fetch({ ...ENTRY, keywords: false }, ctx);
  assert.equal(jobs.length, 25);
  assert.ok(calls.every((c) => c.searchText === ''));
  assert.equal(jobs.keywordSearch, undefined);
});

test('total ≤ keyword_min_total → full fetch, page 0 reused, no keyword requests', async () => {
  const { ctx, calls } = makeCtx({ '': { total: 45, n: 45 } });
  const jobs = await workday.fetch({ ...ENTRY, keywords: ['intern', 'student'], keyword_min_total: 100 }, ctx);
  assert.equal(jobs.length, 45);
  assert.deepEqual(calls.map((c) => [c.searchText, c.offset]), [['', 0], ['', 20], ['', 40]]);
  assert.equal(jobs.keywordSearch, undefined);
});

test('total > keyword_min_total → one paginated query per term, merged + deduped, marker set', async () => {
  // 'internship' returns the same postings as 'intern' (same requisition ids) plus nothing new.
  const { ctx, calls, sleeps } = makeCtx({
    '': { total: 5000, n: 5000 },
    intern: { total: 30, n: 30, tag: 'intern' },
    internship: { total: 30, n: 30, tag: 'intern' },
    student: { total: 5, n: 5, tag: 'student' },
  });
  const jobs = await workday.fetch({ ...ENTRY, keywords: ['intern', 'internship', 'student'], keyword_min_total: 1000 }, ctx);
  assert.deepEqual(calls.map((c) => [c.searchText, c.offset]), [
    ['', 0], ['intern', 0], ['intern', 20], ['internship', 0], ['internship', 20], ['student', 0],
  ]);
  assert.equal(jobs.length, 35);
  assert.equal(jobs[0].title, 'intern job 0');
  assert.equal(jobs[30].title, 'student job 0');
  assert.deepEqual(jobs.keywordSearch, { mode: 'keywords', terms: 3, boardTotal: 5000, perTerm: { intern: 30, internship: 30, student: 5 } });
  assert.equal(jobs.truncated, undefined);
  // Delay before every non-first page and between terms.
  assert.ok(sleeps.length >= 4 && sleeps.every((ms) => ms > 0));
  // Same job object shape as the full path.
  assert.deepEqual(Object.keys(jobs[0]).sort(), ['company', 'location', 'postedAt', 'title', 'url']);
});

test('dedup across terms falls back to URL when the URL carries no requisition id', async () => {
  const noId = (tag, offset, n) => Array.from({ length: n }, (_, i) => ({ title: `${tag} ${offset + i}`, externalPath: `/job/city/shared-${offset + i}` }));
  const { ctx } = makeCtx({
    '': { total: 5000, n: 5000 },
    a: { total: 3, n: 3, make: noId, tag: 'x' },
    b: { total: 3, n: 3, make: noId, tag: 'y' },
  });
  const jobs = await workday.fetch({ ...ENTRY, keywords: ['a', 'b'] }, ctx);
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs.keywordSearch.perTerm, { a: 3, b: 3 });
});

test('a term that hits max_pages → truncated = true', async () => {
  const { ctx } = await (async () => makeCtx({
    '': { total: 5000, n: 5000 },
    intern: { total: 100, n: 100 },
    student: { total: 5, n: 5 },
  }))();
  const jobs = await quiet(() => workday.fetch({ ...ENTRY, max_pages: 2, keywords: ['intern', 'student'], keyword_min_total: 10 }, ctx));
  assert.equal(jobs.truncated, true);
  assert.equal(jobs.keywordSearch.perTerm.intern, 40);
  assert.equal(jobs.keywordSearch.perTerm.student, 5);
});

test('unknown board total with keywords → keyword search', async () => {
  const { ctx, calls } = makeCtx({
    '': { n: 20 }, // no total reported
    intern: { n: 4 },
  });
  const jobs = await workday.fetch({ ...ENTRY, keywords: ['intern'], keyword_min_total: 1000000 }, ctx);
  assert.deepEqual(calls.map((c) => c.searchText), ['', 'intern']);
  assert.equal(jobs.length, 4);
  assert.deepEqual(jobs.keywordSearch, { mode: 'keywords', terms: 1, boardTotal: null, perTerm: { intern: 4 } });
});

test('keywords without keyword_min_total → keyword search unconditionally', async () => {
  const { ctx, calls } = makeCtx({ '': { total: 3, n: 3 }, intern: { total: 1, n: 1 } });
  const jobs = await workday.fetch({ ...ENTRY, keywords: ['intern'] }, ctx);
  assert.deepEqual(calls.map((c) => c.searchText), ['', 'intern']);
  assert.equal(jobs.length, 1);
  assert.equal(jobs.keywordSearch.boardTotal, 3);
});

test('a clamped keyword result still goes through the facet split', async () => {
  const facets = [{ facetParameter: 'jobFamily', values: [{ id: 'a', count: 1500 }, { id: 'b', count: 1200 }] }];
  const { ctx, calls } = makeCtx({
    '': { total: 2000, n: 2000, facets },
    intern: { total: 2000, n: 2000, facets, tag: 'intern' },
    'intern|jobFamily=a': { total: 20, n: 20, tag: 'ia' },
    'intern|jobFamily=b': { total: 20, n: 20, tag: 'ib' },
  });
  const jobs = await quiet(() => workday.fetch({ ...ENTRY, keywords: ['intern'], keyword_min_total: 2500 }, ctx));
  const sliced = calls.filter((c) => Object.keys(c.appliedFacets).length > 0);
  assert.ok(sliced.length === 2 && sliced.every((c) => c.searchText === 'intern'));
  // Board total read from facets (2700 > clamped 2000) → over the 2500 threshold.
  assert.equal(jobs.keywordSearch.boardTotal, 2700);
  assert.equal(jobs.keywordSearch.perTerm.intern, 2000 + 40);
  assert.equal(jobs.truncated, undefined);
});

test('a term whose first page fails is skipped; other terms still returned', async () => {
  const { ctx } = makeCtx({ '': { total: 5000, n: 5000 }, student: { total: 2, n: 2 } });
  const jobs = await quiet(() => workday.fetch({ ...ENTRY, keywords: ['intern', 'student'], keyword_min_total: 10 }, { ...ctx, fetchJson: async (u, o) => {
    if (JSON.parse(o.body).searchText === 'intern') { const e = new Error('HTTP 400'); e.status = 400; throw e; }
    return ctx.fetchJson(u, o);
  } }));
  assert.equal(jobs.length, 2);
  assert.equal(jobs.workdayTruncated, true);
  assert.deepEqual(jobs.keywordSearch.perTerm, { intern: 0, student: 2 });
});

test('liveness probe (ctx.maxPages) ignores keywords — one request', async () => {
  const { ctx, calls } = makeCtx({ '': { total: 5000, n: 5000 } });
  const jobs = await workday.fetch({ ...ENTRY, keywords: ['intern'] }, { ...ctx, maxPages: 1 });
  assert.equal(calls.length, 1);
  assert.equal(jobs.keywordSearch, undefined);
});

// ── facet-first ───────────────────────────────────────────────────

// Trimmed from live CVS Health page 0 (2026-11-09): workerSubType and
// jobFamilyGroup both tag students; locations (nested, 4,987 values) has an
// "OH - University Heights" that must never count.
const CVS_FACETS = [
  { facetParameter: 'timeType', descriptor: 'Full/Part-time', values: [{ id: 'ft', descriptor: 'Full time', count: 15000 }, { id: 'pt', descriptor: 'Part time', count: 4000 }] },
  { facetParameter: 'workerSubType', descriptor: 'Job Type', values: [
    { id: 'wst-reg', descriptor: 'Regular', count: 14763 },
    { id: 'wst-int', descriptor: 'Intern (Seasonal) (Trainee)', count: 56 },
    { id: 'wst-rx', descriptor: 'Pharmacy Intern (Trainee)', count: 3929 },
    { id: 'wst-zero', descriptor: 'Student Worker', count: 0 },
  ] },
  { facetParameter: 'jobFamilyGroup', descriptor: 'Job Category', values: [
    { id: 'jfg-int', descriptor: 'Internships and Devlpmt Pgms', count: 3989 },
    { id: 'jfg-audit', descriptor: 'Internal Audit', count: 40 },
  ] },
  { facetParameter: 'locationMainGroup', descriptor: null, values: [
    { facetParameter: 'locations', descriptor: 'Locations', values: [{ id: 'loc-uh', descriptor: 'OH - University Heights', count: 16 }] },
  ] },
];

test('chooseStudentFacet: fewest matching jobs (>0) wins; skips locations, zero counts', () => {
  const f = chooseStudentFacet(CVS_FACETS, buildFacetValuesMatcher(resolveFacetValues({})));
  assert.equal(f.facetParameter, 'workerSubType');
  assert.deepEqual(f.values.map((v) => v.id), ['wst-int', 'wst-rx']);
  assert.equal(f.total, 3985);
});

test('chooseStudentFacet: internal/international never count, facets over 200 values skipped', () => {
  const re = buildFacetValuesMatcher(['intern']);
  assert.equal(chooseStudentFacet([{ facetParameter: 'jobFamilyGroup', values: [{ id: 'a', descriptor: 'Internal Audit', count: 5 }, { id: 'b', descriptor: 'International Tax', count: 3 }] }], re), null);
  const wide = Array.from({ length: 201 }, (_, i) => ({ id: `v${i}`, descriptor: i === 0 ? 'Intern' : `Req ${i}`, count: 1 }));
  assert.equal(chooseStudentFacet([{ facetParameter: 'jobReqId', values: wide }], re), null);
});

test('chooseStudentFacet: store/site/title facets excluded; worker-type facet preferred over a smaller generic one', () => {
  const re = buildFacetValuesMatcher(resolveFacetValues({}));
  const facets = [
    { facetParameter: 'store', descriptor: 'Store', values: [{ id: 's1', descriptor: 'University Park', count: 1 }, { id: 's2', descriptor: 'Dallas', count: 50 }] },
    { facetParameter: 'site', descriptor: 'Site', values: [{ id: 'x', descriptor: 'Campus North', count: 2 }] },
    { facetParameter: 'jobTitle', descriptor: 'Job Title', values: [{ id: 't', descriptor: 'Student Ambassador', count: 3 }] },
    { facetParameter: 'misc', descriptor: 'Misc', values: [{ id: 'm', descriptor: 'Contract', count: 4 }] },
    { facetParameter: 'workerSubType', descriptor: 'Job Type', values: [{ id: 'i', descriptor: 'Intern', count: 100 }, { id: 'r', descriptor: 'Regular', count: 900 }] },
  ];
  const f = chooseStudentFacet(facets, re);
  assert.equal(f.facetParameter, 'workerSubType');
  assert.deepEqual(f.values.map((v) => v.id), ['i']);
  // Without a preferred facet, a non-excluded generic one still qualifies.
  assert.equal(chooseStudentFacet(facets.slice(0, 4), re).facetParameter, 'misc');
});

test('chooseStudentFacet: a Tags facet is preferred over a smaller ordinary facet', () => {
  const m = buildFacetValuesMatcher(resolveFacetValues({}));
  const facets = [
    { facetParameter: 'misc', descriptor: 'Misc', values: [{ id: 'm', descriptor: 'Contract', count: 1 }] },
    { facetParameter: 'jobTags', descriptor: 'Tags', values: [{ id: 't', descriptor: 'Internship', count: 20 }, { id: 'o', descriptor: 'Remote', count: 50 }] },
  ];
  const f = chooseStudentFacet(facets, m);
  assert.equal(f.facetParameter, 'jobTags');
  assert.deepEqual(f.values.map((v) => v.id), ['t']);
});

const facetBoard = (facets = CVS_FACETS) => ({
  '': { total: 19060, n: 19060, facets },
  '|workerSubType=wst-int,wst-rx': { total: 25, n: 25, tag: 'fac' },
  intern: { total: 3, n: 3, tag: 'kw' },
});

test('facet used when available: one query with every matching value, no keyword requests', async () => {
  const { ctx, calls } = makeCtx(facetBoard());
  const jobs = await workday.fetch({ ...ENTRY, keywords: ['intern'], keyword_min_total: 1000 }, ctx);
  assert.ok(calls.every((c) => c.searchText === ''));
  assert.deepEqual(calls.map((c) => [JSON.stringify(c.appliedFacets), c.offset]), [
    ['{}', 0], ['{"workerSubType":["wst-int","wst-rx"]}', 0], ['{"workerSubType":["wst-int","wst-rx"]}', 20],
  ]);
  assert.equal(jobs.length, 25);
  assert.deepEqual(jobs.keywordSearch, {
    mode: 'facet', terms: 0, boardTotal: 19060, perTerm: {},
    facet: { name: 'workerSubType', values: ['Intern (Seasonal) (Trainee)', 'Pharmacy Intern (Trainee)'] },
  });
});

test('facet query returning nothing → keyword fallback', async () => {
  const b = facetBoard();
  b['|workerSubType=wst-int,wst-rx'] = { total: 0, n: 0 };
  const { ctx, calls } = makeCtx(b);
  const jobs = await quiet(() => workday.fetch({ ...ENTRY, keywords: ['intern'], keyword_min_total: 1000 }, ctx));
  assert.equal(calls.at(-1).searchText, 'intern');
  assert.equal(jobs.keywordSearch.mode, 'keywords');
  assert.equal(jobs.length, 3);
});

test('no facet value matches → keyword search', async () => {
  const facets = [{ facetParameter: 'workerSubType', values: [{ id: 'r', descriptor: 'Regular', count: 19060 }] }];
  const { ctx, calls } = makeCtx(facetBoard(facets));
  const jobs = await workday.fetch({ ...ENTRY, keywords: ['intern'], keyword_min_total: 1000 }, ctx);
  assert.ok(calls.every((c) => Object.keys(c.appliedFacets).length === 0));
  assert.equal(jobs.keywordSearch.mode, 'keywords');
  assert.equal(jobs.keywordSearch.facet, undefined);
});

test('entry.facet: false → keyword search even when a facet matches', async () => {
  const { ctx, calls } = makeCtx(facetBoard());
  const jobs = await workday.fetch({ ...ENTRY, keywords: ['intern'], keyword_min_total: 1000, facet: false }, ctx);
  assert.deepEqual(calls.map((c) => c.searchText), ['', 'intern']);
  assert.equal(jobs.keywordSearch.mode, 'keywords');
});

test('facet_values matcher: plain words, whole-word, plural / possessive, no regex meaning', () => {
  const m = buildFacetValuesMatcher(resolveFacetValues({}));
  for (const ok of ['Intern', 'Interns', 'Internships and Devlpmt Pgms', 'Students', "Master's", 'Early-Career', 'Early  Talent', 'Co-op', 'Graduate Programme', 'University Hire'])
    assert.equal(m(ok), true, ok);
  for (const no of ['Internal Audit', 'International Pharmacy', 'Regular', 'Contractor', 'Mastering', 'Campus-wide'.replace('-wide', 'wide'), 'coopers'])
    assert.equal(m(no), false, no);
  // 'contract' matches "Contract" but not "Contractor".
  assert.equal(m('Contract'), true);
  // Descriptor truncated to 200 chars before matching.
  assert.equal(m(`${'x'.repeat(200)} Intern`), false);
  assert.equal(m(`${'x'.repeat(190)} Intern`), true);
  // Words are literal, not regex: "c++" and "." do not become patterns.
  const lit = buildFacetValuesMatcher(['c++', 'a.b']);
  assert.equal(lit('C++ Developer'), true);
  assert.equal(lit('acb'), false);
  assert.equal(lit('a.b'), true);
  // A regex-looking string is treated as plain text and never as a pattern.
  const bogus = buildFacetValuesMatcher(['.*']);
  assert.equal(bogus('Regular'), false);
  assert.equal(bogus('Rate .*'), true);
});

test('resolveFacetValues: array of words; empty/absent/non-array → default list', () => {
  assert.deepEqual(resolveFacetValues({}), ['intern', 'internship', 'co-op', 'coop', 'student', 'contract', 'master', 'graduate', 'early career', 'early talent', 'campus', 'university', 'apprentice']);
  assert.deepEqual(resolveFacetValues({ facet_values: [] }), resolveFacetValues({}));
  assert.deepEqual(resolveFacetValues({ facet_values: 'intern|student' }), resolveFacetValues({}));
  assert.deepEqual(resolveFacetValues({ facet_values: [' Devlpmt Pgms ', '', 7] }), ['Devlpmt Pgms']);
});

test('entry.facet_values honoured: custom word list picks jobFamilyGroup', async () => {
  const b = facetBoard();
  b['|jobFamilyGroup=jfg-int'] = { total: 7, n: 7, tag: 'jfg' };
  const { ctx } = makeCtx(b);
  const jobs = await workday.fetch({ ...ENTRY, keywords: ['intern'], keyword_min_total: 1000, facet_values: ['devlpmt pgms'] }, ctx);
  assert.equal(jobs.keywordSearch.mode, 'facet');
  assert.deepEqual(jobs.keywordSearch.facet, { name: 'jobFamilyGroup', values: ['Internships and Devlpmt Pgms'] });
  assert.equal(jobs.length, 7);
});

test('small board with a student facet still fetched whole', async () => {
  const facets = [{ facetParameter: 'workerSubType', values: [{ id: 'r', descriptor: 'Regular', count: 25 }, { id: 'i', descriptor: 'Intern', count: 5 }] }];
  const { ctx, calls } = makeCtx({ '': { total: 30, n: 30, facets } });
  const jobs = await workday.fetch({ ...ENTRY, keywords: ['intern'], keyword_min_total: 1000 }, ctx);
  assert.equal(jobs.length, 30);
  assert.ok(calls.every((c) => Object.keys(c.appliedFacets).length === 0 && c.searchText === ''));
  assert.equal(jobs.keywordSearch, undefined);
});
