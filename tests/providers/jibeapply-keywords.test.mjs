// tests/providers/jibeapply-keywords.test.mjs — keyword search (entry.keywords /
// entry.keyword_min_total) for the JibeApply provider. In-memory fetch stubs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const { default: jibeapply } = await import(pathToFileURL(join(ROOT, 'providers/jibeapply.mjs')).href);

const API = 'https://acme.jibeapply.com/api/jobs';
const job = (slug, title = `Job ${slug}`) => ({ data: { slug, title, full_location: 'X' } });

/**
 * Stub board: `full` is the unfiltered board, `byTerm` maps a keywords= value to
 * its result list. Pages are 10 rows; totalCount is the list length unless
 * overridden (`totals`). Records every requested URL.
 */
function stubCtx({ full = [], byTerm = {}, totals = {}, noTotal = false, fail = new Set(),
  filter = undefined, byFacet = {} } = {}) {
  const calls = [];
  const ctx = {
    fetchJson: async (url) => {
      calls.push(url);
      const u = new URL(url);
      const term = u.searchParams.get('keywords');
      if (term !== null && fail.has(term)) throw new Error('HTTP 500');
      // byFacet: { "<name>=<value>": [jobs] } — the exact query value, OR-ed values joined by "|".
      const facetKey = Object.keys(byFacet).find(k => {
        const [n, v] = k.split('=');
        return u.searchParams.get(n) === v;
      });
      if (facetKey) {
        const list = byFacet[facetKey];
        const page = Number(u.searchParams.get('page') || '1');
        const jobs = list.slice((page - 1) * 10, page * 10);
        return { jobs, count: jobs.length, totalCount: list.length };
      }
      const list = term === null ? full : (byTerm[term] ?? []);
      const page = Number(u.searchParams.get('page') || '1');
      const jobs = list.slice((page - 1) * 10, page * 10);
      const key = term === null ? '' : term;
      const body = { jobs, count: jobs.length };
      if (!noTotal) body.totalCount = key in totals ? totals[key] : list.length;
      if (filter && term === null) body.filter = filter;
      return body;
    },
  };
  return { ctx, calls };
}

const range = (prefix, n) => Array.from({ length: n }, (_, i) => job(`${prefix}${i}`));

test('keywords absent → unchanged full fetch, no keywords= requests, no marker', async () => {
  const { ctx, calls } = stubCtx({ full: range('a', 25) });
  for (const keywords of [undefined, [], false]) {
    calls.length = 0;
    const jobs = await jibeapply.fetch({ name: 'Acme', careers_url: API, keywords }, ctx);
    assert.equal(jobs.length, 25);
    assert.equal(calls.length, 3);
    assert.ok(calls.every(c => !c.includes('keywords=')));
    assert.equal(jobs.keywordSearch, undefined);
    assert.deepEqual(Object.keys(jobs[0]).sort(), ['company', 'location', 'title', 'url']);
  }
});

test('total ≤ keyword_min_total → full fetch, no keyword requests', async () => {
  const { ctx, calls } = stubCtx({ full: range('a', 15), byTerm: { intern: [job('i1')] } });
  const jobs = await jibeapply.fetch(
    { name: 'Acme', careers_url: API, keywords: ['intern'], keyword_min_total: 15 }, ctx);
  assert.equal(jobs.length, 15);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => !c.includes('keywords=')));
  assert.equal(jobs.keywordSearch, undefined);
});

test('total > keyword_min_total → one paginated query per term, merged + deduped + marker', async () => {
  const shared = job('s1', 'Summer Intern Student');
  const { ctx, calls } = stubCtx({
    full: range('a', 500),
    byTerm: {
      intern: [shared, ...range('i', 11)],       // 12 rows → 2 pages
      student: [job('i3'), shared, job('st1')],   // i3 and s1 duplicate
      'summer analyst': [],
    },
  });
  const jobs = await jibeapply.fetch({
    name: 'Acme', careers_url: `${API}?location=US`,
    keywords: ['intern', 'student', 'summer analyst'], keyword_min_total: 100,
  }, ctx);

  const termCalls = calls.filter(c => c.includes('keywords='));
  // intern: pages 1-2, student: 1, summer analyst: 1
  assert.equal(termCalls.length, 4);
  assert.equal(calls.length, 5); // + the unfiltered first page
  assert.ok(termCalls.every(c => new URL(c).searchParams.get('location') === 'US'));
  assert.ok(termCalls.some(c => new URL(c).searchParams.get('keywords') === 'summer analyst'));
  assert.ok(termCalls.some(c => new URL(c).searchParams.get('page') === '2'));

  assert.equal(jobs.length, 13); // 12 intern + st1
  assert.equal(jobs[0].url, 'https://acme.jibeapply.com/jobs/s1');
  assert.equal(jobs.at(-1).url, 'https://acme.jibeapply.com/jobs/st1');
  assert.equal(new Set(jobs.map(j => j.url)).size, jobs.length);
  assert.deepEqual(jobs.keywordSearch, { mode: 'keywords',
    terms: 3, boardTotal: 500, perTerm: { intern: 12, student: 3, 'summer analyst': 0 },
  });
  assert.equal(jobs.truncated, undefined);
  assert.deepEqual(Object.keys(jobs[0]).sort(), ['company', 'location', 'title', 'url']);
});

test('keywords without keyword_min_total → keyword search unconditionally', async () => {
  const { ctx, calls } = stubCtx({ full: range('a', 5), byTerm: { intern: [job('i1')] } });
  const jobs = await jibeapply.fetch({ name: 'Acme', careers_url: API, keywords: ['intern'] }, ctx);
  assert.equal(jobs.length, 1);
  assert.equal(calls.filter(c => c.includes('keywords=')).length, 1);
  assert.deepEqual(jobs.keywordSearch, { mode: 'keywords', terms: 1, boardTotal: 5, perTerm: { intern: 1 } });
});

test('per-term page cap → truncated = true', async () => {
  const { ctx, calls } = stubCtx({
    full: range('a', 50),
    byTerm: { intern: range('i', 35), student: [job('st1')] },
  });
  const origErr = console.error;
  console.error = () => {};
  let jobs;
  try {
    jobs = await jibeapply.fetch({
      name: 'Acme', careers_url: API, keywords: ['intern', 'student'],
      keyword_min_total: 10, max_pages: 2,
    }, ctx);
  } finally { console.error = origErr; }
  assert.equal(calls.filter(c => new URL(c).searchParams.get('keywords') === 'intern').length, 2);
  assert.equal(jobs.length, 21);
  assert.equal(jobs.truncated, true);
  assert.deepEqual(jobs.keywordSearch.perTerm, { intern: 20, student: 1 });
});

test('unknown board total with keywords + min → keyword search', async () => {
  const { ctx, calls } = stubCtx({
    full: range('a', 3), byTerm: { intern: [job('i1')] }, noTotal: true,
  });
  const jobs = await jibeapply.fetch(
    { name: 'Acme', careers_url: API, keywords: ['intern'], keyword_min_total: 1000 }, ctx);
  assert.equal(calls.filter(c => c.includes('keywords=')).length, 1);
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs.keywordSearch, { mode: 'keywords', terms: 1, boardTotal: null, perTerm: { intern: 1 } });
});

test('a failing term is skipped and marks the result partial', async () => {
  const { ctx } = stubCtx({
    full: range('a', 50), byTerm: { student: [job('st1')] }, fail: new Set(['intern']),
  });
  const origErr = console.error;
  console.error = () => {};
  let jobs;
  try {
    jobs = await jibeapply.fetch(
      { name: 'Acme', careers_url: API, keywords: ['intern', 'student'], keyword_min_total: 10 }, ctx);
  } finally { console.error = origErr; }
  assert.equal(jobs.length, 1);
  assert.equal(jobs.partial, true);
  assert.deepEqual(jobs.keywordSearch.perTerm, { intern: 0, student: 1 });
});

const ULTA_LIKE_FILTER = {
  facetList: {
    tags1: [{ term: 'Full Time', count: 100 }, { term: 'Internship', count: 12 }, { term: 'Co-op', count: 1 }],
    tags3: [{ term: 'DC Intern', count: 3 }, { term: 'Manager International Compensation', count: 1 }, { term: 'Stylist', count: 9 }, { term: 'A', count: 1 }],
    state: [{ term: 'University Park', count: 2 }],
  },
  categories: { all: [{ category: 'Internships', numJobs: 12 }, { category: 'Finance', numJobs: 3 }, { category: 'Stores', numJobs: 5 }, { category: 'IT', numJobs: 1 }] },
};

test('findStudentFacet picks the smallest matching facet, word-bounded, skipping locations', async () => {
  const { findStudentFacet } = await import(pathToFileURL(join(ROOT, 'providers/jibeapply.mjs')).href);
  assert.deepEqual(findStudentFacet({ filter: ULTA_LIKE_FILTER }), { name: 'tags1', values: ['Internship', 'Co-op'] });
  assert.equal(findStudentFacet({ filter: { facetList: { tags1: [{ term: 'International', count: 4 }] } } }), null);
  assert.equal(findStudentFacet({ filter: { facetList: { state: [{ term: 'University Hills', count: 4 }] } } }), null);
  assert.deepEqual(
    findStudentFacet({ filter: { facetList: {}, categories: { all: [{ category: 'Early Careers', numJobs: 2 }] } } }),
    { name: 'categories', values: ['Early Careers'] });
  assert.equal(findStudentFacet({}), null);
});

test('facet matcher: contract / master / apprentice values included (optional s or \'s), internal/international-only excluded', async () => {
  const { findStudentFacet } = await import(pathToFileURL(join(ROOT, 'providers/jibeapply.mjs')).href);
  const filter = { facetList: { tags1: [
    { term: 'Full Time', count: 50 }, { term: 'Contract', count: 4 }, { term: 'Contracts', count: 2 },
    { term: "Master's Program", count: 1 }, { term: 'Apprentice', count: 3 }, { term: 'Internal', count: 9 },
    { term: 'International Assignment', count: 2 }, { term: 'Internships', count: 6 }, { term: 'Early Talent', count: 2 },
    { term: 'Contractor', count: 1 }, { term: 'Masterful Sales', count: 1 }, { term: 'Internal Audit Intern', count: 1 },
  ] } };
  // whole words only: "Contractor" and "Masterful" do not match; "Internal Audit Intern" matches on "Intern".
  assert.deepEqual(findStudentFacet({ filter }), { name: 'tags1',
    values: ['Contract', 'Contracts', "Master's Program", 'Apprentice', 'Internships', 'Early Talent', 'Internal Audit Intern'] });
});

test('all matching values of the chosen facet are fetched in one OR-ed query and merged', async () => {
  const filter = { facetList: { tags1: [
    { term: 'Internship', count: 2 }, { term: 'Contract', count: 2 }, { term: 'Full Time', count: 90 },
  ] } };
  const { ctx, calls } = stubCtx({
    full: range('a', 500), filter,
    byFacet: { 'tags1=Internship|Contract': [job('in1'), job('in2'), job('c1'), job('c2'), job('in1')] },
  });
  const jobs = await jibeapply.fetch(
    { name: 'Acme', careers_url: API, keywords: ['intern'], keyword_min_total: 100 }, ctx);
  assert.equal(calls.length, 2);
  assert.deepEqual(jobs.map(j => j.url.split('/').pop()), ['in1', 'in2', 'c1', 'c2']);
  assert.deepEqual(jobs.keywordSearch.facet, { name: 'tags1', values: ['Internship', 'Contract'] });
});

test('student facet available → facet query only, no keyword requests, mode=facet', async () => {
  const { ctx, calls } = stubCtx({
    full: range('a', 500), filter: ULTA_LIKE_FILTER,
    byFacet: { 'tags1=Internship|Co-op': range('f', 13) },
    byTerm: { intern: [job('i1')] },
  });
  const jobs = await jibeapply.fetch(
    { name: 'Acme', careers_url: API, keywords: ['intern', 'student'], keyword_min_total: 100 }, ctx);
  assert.equal(calls.filter(c => c.includes('keywords=')).length, 0);
  assert.equal(calls.length, 3); // board page + facet pages 1-2
  assert.equal(jobs.length, 13);
  assert.deepEqual(jobs.keywordSearch, {
    mode: 'facet', facet: { name: 'tags1', values: ['Internship', 'Co-op'] },
    terms: 0, boardTotal: 500, perTerm: {},
  });
  assert.deepEqual(Object.keys(jobs[0]).sort(), ['company', 'location', 'title', 'url']);
});

test('no matching facet value → keyword search', async () => {
  const { ctx, calls } = stubCtx({
    full: range('a', 500),
    filter: { facetList: { tags1: [{ term: 'Full Time', count: 400 }, { term: 'Part Time', count: 100 }] } },
    byTerm: { intern: [job('i1')] },
  });
  const jobs = await jibeapply.fetch(
    { name: 'Acme', careers_url: API, keywords: ['intern'], keyword_min_total: 100 }, ctx);
  assert.equal(calls.filter(c => c.includes('keywords=')).length, 1);
  assert.equal(calls.filter(c => c.includes('tags1=')).length, 0);
  assert.equal(jobs.keywordSearch.mode, 'keywords');
  assert.equal(jobs.length, 1);
});

test('facet yields nothing → falls back to keyword search', async () => {
  const { ctx, calls } = stubCtx({
    full: range('a', 500), filter: ULTA_LIKE_FILTER,
    byFacet: { 'tags1=Internship|Co-op': [] },
    byTerm: { intern: [job('i1')] },
  });
  const jobs = await jibeapply.fetch(
    { name: 'Acme', careers_url: API, keywords: ['intern'], keyword_min_total: 100 }, ctx);
  assert.equal(calls.filter(c => c.includes('tags1=')).length, 1);
  assert.equal(calls.filter(c => c.includes('keywords=')).length, 1);
  assert.equal(jobs.keywordSearch.mode, 'keywords');
});

test('entry.facet: false → no facet attempt, keyword search', async () => {
  const { ctx, calls } = stubCtx({
    full: range('a', 500), filter: ULTA_LIKE_FILTER,
    byFacet: { 'tags1=Internship|Co-op': range('f', 13) },
    byTerm: { intern: [job('i1')] },
  });
  const jobs = await jibeapply.fetch(
    { name: 'Acme', careers_url: API, keywords: ['intern'], keyword_min_total: 100, facet: false }, ctx);
  assert.equal(calls.filter(c => c.includes('tags1=')).length, 0);
  assert.equal(calls.filter(c => c.includes('keywords=')).length, 1);
  assert.equal(jobs.keywordSearch.mode, 'keywords');
  assert.equal(jobs.length, 1);
});

test('small board (≤ min) with a student facet → still full fetch, no facet query', async () => {
  const { ctx, calls } = stubCtx({ full: range('a', 15), filter: ULTA_LIKE_FILTER, byFacet: { 'tags1=Internship|Co-op': [job('f1')] } });
  const jobs = await jibeapply.fetch(
    { name: 'Acme', careers_url: API, keywords: ['intern'], keyword_min_total: 100 }, ctx);
  assert.equal(jobs.length, 15);
  assert.equal(calls.length, 2);
  assert.equal(jobs.keywordSearch, undefined);
});

test('entry.facet_values (array of words) replaces the default list, case-insensitive, internal/international still excluded', async () => {
  const filter = { facetList: { tags1: [
    { term: 'Internship', count: 3 }, { term: 'Seasonal', count: 7 }, { term: 'International', count: 1 },
    { term: 'Full Time', count: 90 },
  ] } };
  const { ctx, calls } = stubCtx({
    full: range('a', 500), filter,
    byFacet: { 'tags1=Seasonal': [job('s1'), job('s2')] },
    byTerm: { intern: [job('i1')] },
  });
  const jobs = await jibeapply.fetch({
    name: 'Acme', careers_url: API, keywords: ['intern'], keyword_min_total: 100,
    facet_values: ['SEASONAL', 'international'],
  }, ctx);
  assert.equal(calls.filter(c => c.includes('keywords=')).length, 0);
  assert.deepEqual(jobs.keywordSearch.facet, { name: 'tags1', values: ['Seasonal'] });
  assert.equal(jobs.length, 2);
});

test('entry.facet_values empty, non-array or a string → built-in default list', async () => {
  const { findStudentFacet } = await import(pathToFileURL(join(ROOT, 'providers/jibeapply.mjs')).href);
  const filter = { facetList: { tags1: [{ term: 'Internship', count: 3 }, { term: 'Seasonal', count: 7 }] } };
  for (const facet_values of [undefined, [], ['', '  '], 'seasonal', 42, [7]]) {
    const { ctx } = stubCtx({ full: range('a', 500), filter, byFacet: { 'tags1=Internship': [job('f1')] } });
    const jobs = await jibeapply.fetch(
      { name: 'Acme', careers_url: API, keywords: ['intern'], keyword_min_total: 100, facet_values }, ctx);
    assert.deepEqual(jobs.keywordSearch.facet, { name: 'tags1', values: ['Internship'] }, JSON.stringify(facet_values));
  }
  assert.deepEqual(findStudentFacet({ filter }), { name: 'tags1', values: ['Internship'] });
});

// ── review fixes (2026-11-09) ────────────────────────────────────────────────
const { findStudentFacet: pickFacet } = await import(pathToFileURL(join(ROOT, 'providers/jibeapply.mjs')).href);

test('review 1: store/title facets are excluded; role-type facet names win over fewer values', () => {
  const filter = { facetList: {
    store: [{ term: 'ST0070 University Hills CO', count: 9 }],
    title: [{ term: 'Master Electrician', count: 1 }],
    job_title: [{ term: 'Intern Electrician', count: 1 }],
    brand: [{ term: 'Campus Brand', count: 1 }],
    tags1: [{ term: 'Internship', count: 4 }, { term: 'Full Time', count: 90 }],
  } };
  assert.deepEqual(pickFacet({ filter }), { name: 'tags1', values: ['Internship'] });
  const pref = { facetList: {
    misc: [{ term: 'Intern', count: 1 }],
    employment_type: [{ term: 'Intern', count: 3 }, { term: 'Full Time', count: 50 }, { term: 'Part Time', count: 20 }],
  } };
  assert.deepEqual(pickFacet({ filter: pref }), { name: 'employment_type', values: ['Intern'] });
});

test('review 2: values whose only hit is internal/international are never sent, even when configured', async () => {
  const { buildFacetMatcher } = await import(pathToFileURL(join(ROOT, 'providers/jibeapply.mjs')).href);
  const filter = { facetList: { tags1: [{ term: 'Internal', count: 3 }, { term: 'International', count: 2 }] } };
  const { ctx, calls } = stubCtx({ full: range('a', 500), filter, byTerm: { intern: [job('i1')] } });
  const jobs = await jibeapply.fetch({
    name: 'Acme', careers_url: API, keywords: ['intern'], keyword_min_total: 100, facet_values: ['internal', 'international'],
  }, ctx);
  assert.equal(calls.filter(c => c.includes('tags1=')).length, 0);
  assert.equal(jobs.keywordSearch.mode, 'keywords');
  assert.equal(pickFacet({ filter }, buildFacetMatcher(['intern'])), null);
  const mixed = { facetList: { tags1: [{ term: 'Internal', count: 3 }, { term: 'International Seasonal', count: 1 }, { term: 'Seasonal', count: 2 }] } };
  assert.deepEqual(pickFacet({ filter: mixed }, buildFacetMatcher(['seasonal'])), { name: 'tags1', values: ['International Seasonal', 'Seasonal'] });
});

test('review 3: configured words are literal (regex characters escaped), whole-word, and values are truncated to 200 chars', async () => {
  const { buildFacetMatcher } = await import(pathToFileURL(join(ROOT, 'providers/jibeapply.mjs')).href);
  const m = buildFacetMatcher(['a+', '.*', '(intern', 'early career']);
  assert.equal(m.test('A+ Program'), true);
  assert.equal(m.test('aaa Program'), false);       // "a+" is literal, not a quantifier
  assert.equal(m.test('Anything'), false);           // ".*" is literal
  assert.equal(m.test('Internship'), false);         // "(intern" is literal, not an open group
  assert.equal(m.test('Early   Careers'), true);     // whitespace runs collapse; plural allowed
  assert.equal(m.test('Nearly careers'), false);     // whole word
  const filter = { facetList: { tags1: [
    { term: 'a'.repeat(5000) + ' Intern', count: 1 }, { term: 'Intern ' + 'a'.repeat(5000), count: 1 },
    { term: 'Internship', count: 4 }, { term: 'Full Time', count: 90 },
  ] } };
  const picked = pickFacet({ filter });
  assert.deepEqual(picked, { name: 'tags1', values: ['Intern ' + 'a'.repeat(5000), 'Internship'] });
});
