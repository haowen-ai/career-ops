// tests/providers/taleo.test.mjs — Oracle Taleo Enterprise career sections
// (POST /careersection/rest/jobboard/searchjobs).
//
// The fixture is a trimmed live response (tas-hyatt section 10780,
// 2026-11-07, 3 rows, 5-column layout); no network is used — ctx is stubbed.
//
// Run:  node --test tests/providers/taleo.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/taleo.mjs')).href);
const tl = mod.default;
const { resolveConfig, buildSearchUrl, buildSearchBody, parseSearchResponse, findUsLocation, toEpochMs } = mod;

const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/taleo-search.json'), 'utf8'));
const URL_HY = 'https://tas-hyatt.taleo.net/careersection/10780/jobsearch.ftl?lang=en';
const ENTRY = { name: 'Acme', careers_url: URL_HY };
const CFG = resolveConfig(ENTRY);

/** Synthetic page: `n` rows from id `start`, reporting `total`, optional facets. */
function page(n, start, total, facets) {
  return {
    requisitionList: Array.from({ length: n }, (_, i) => ({
      jobId: String(9000 + start + i),
      contestNo: `R${start + i}`,
      column: [`Job ${start + i}`, '["US-TX-Austin"]', 'Nov 1, 2026'],
      linkedColumn: 0,
      locationsColumns: [1],
    })),
    facetResults: facets || [],
    pagingData: { currentPageNo: 1, pageSize: 25, totalCount: total },
    careerSectionUnAvailable: false,
  };
}

const US_FACETS = [{ id: 'LOCATION', facetValueResults: [
  { id: '1223', text: 'United States', quantity: '30', level: 1 },
  { id: '1038', text: 'Canada', quantity: '10', level: 1 },
] }];

function makeCtx(bodies, extra = {}) {
  const calls = [];
  let i = 0;
  return {
    calls,
    sleep: async () => {},
    fetchJson: async (url, opts) => {
      calls.push({ url, opts, body: opts?.body ? JSON.parse(opts.body) : null });
      const b = bodies[i++];
      if (b instanceof Error) throw b;
      return b === undefined ? page(0, 0, 0) : b;
    },
    ...extra,
  };
}

test('id', () => {
  assert.equal(tl.id, 'taleo');
});

test('detect(): claims https *.taleo.net career-section URLs only', () => {
  assert.deepEqual(tl.detect({ careers_url: URL_HY }), { url: URL_HY });
  assert.ok(tl.detect({ careers_url: 'https://vsco.taleo.net/careersection/vss_in/jobsearch.ftl' }));
  for (const bad of [
    'http://tas-hyatt.taleo.net/careersection/10780/jobsearch.ftl',
    'https://evil.example/careersection/2/jobsearch.ftl',
    'https://valero.taleo.net.evil.example/careersection/2/jobsearch.ftl',
    'https://a.b.taleo.net/careersection/2/jobsearch.ftl',
    'https://valero.taleo.net/',
    'nope',
    '',
  ]) {
    assert.equal(tl.detect({ careers_url: bad }), null, bad);
  }
  assert.equal(tl.detect({}), null);
  assert.equal(tl.detect({ careers_url: 7 }), null);
  assert.equal(tl.detect(null), null);
});

test('resolveConfig(): host + section from the path; keyword; us_only', () => {
  assert.deepEqual(CFG, { origin: 'https://tas-hyatt.taleo.net', section: '10780', keyword: '', usOnly: true });
  const v = resolveConfig({ careers_url: 'https://valero.taleo.net/careersection/vlo-pembroke+career+section/jobsearch.ftl?lang=en&keyword=intern', us_only: false });
  assert.equal(v.section, 'vlo-pembroke career section');
  assert.equal(v.keyword, 'intern');
  assert.equal(v.usOnly, false);
  assert.equal(resolveConfig({ careers_url: 'https://epco.taleo.net/', careersection: 'fieldops' }).section, 'fieldops');
  assert.throws(() => resolveConfig({ careers_url: 'https://epco.taleo.net/' }), /needs a career section/);
  assert.throws(() => resolveConfig({ careers_url: 'https://evil.example/careersection/2/jobsearch.ftl' }), /host not allowed/);
  assert.throws(() => resolveConfig({ careers_url: 'http://epco.taleo.net/careersection/2/x' }), /non-https/);
  assert.throws(() => resolveConfig({}), /careers_url is required/);
});

test('buildSearchUrl()/buildSearchBody(): same host, portalCode, LOCATION filter', () => {
  const u = new URL(buildSearchUrl(CFG));
  assert.equal(u.origin + u.pathname, 'https://tas-hyatt.taleo.net/careersection/rest/jobboard/searchjobs');
  assert.equal(u.searchParams.get('portalCode'), '10780');
  const b = JSON.parse(buildSearchBody(CFG, 3, '1223'));
  assert.equal(b.pageNo, 3);
  assert.deepEqual(b.filterSelectionParam.searchFilterSelections, [{ id: 'LOCATION', selectedValues: ['1223'] }]);
  assert.deepEqual(JSON.parse(buildSearchBody(CFG, 1, null)).filterSelectionParam.searchFilterSelections[0].selectedValues, []);
});

test('toEpochMs(): "Mon D, YYYY" only', () => {
  assert.equal(toEpochMs('Nov 6, 2026'), Date.UTC(2026, 10, 6));
  assert.equal(toEpochMs('garbage'), undefined);
  assert.equal(toEpochMs('Foo 6, 2026'), undefined);
  assert.equal(toEpochMs(5), undefined);
});

test('parseSearchResponse(): real fixture (title/location/date columns from the layout)', () => {
  const { rows, total, rawCount } = parseSearchResponse(FIXTURE, CFG);
  assert.equal(total, 3);
  assert.equal(rawCount, 3);
  assert.equal(rows[0].title, 'Director of Finance - Hyatt: Andaz Scottsdale');
  assert.equal(rows[0].url, 'https://tas-hyatt.taleo.net/careersection/10780/jobdetail.ftl?job=SCO006490&lang=en');
  assert.equal(rows[0].location, 'US-AZ-Scottsdale');
  assert.equal(rows[0].postedAt, Date.UTC(2026, 10, 6));
});

test('parseSearchResponse(): malformed records skipped, not fatal; entities decoded; jobId fallback', () => {
  const { rows, rawCount } = parseSearchResponse({
    requisitionList: [
      null,
      'x',
      { jobId: '1', contestNo: 'A1' }, // no column array
      { jobId: '2', contestNo: 'A2', column: [42, '["US"]'] }, // non-string title
      { jobId: '3', contestNo: 'A3', column: ['', '["US"]'] }, // empty title
      { jobId: {}, contestNo: ['x'], column: ['No usable id'] },
      { jobId: '777', contestNo: 'bad id/../x', column: ['R&amp;D Intern', 'Org', '["US-TX-Austin","US-TX-Dallas"]', 'Oct 1, 2026'], linkedColumn: 0, locationsColumns: [2] },
      { jobId: '8', contestNo: 'B8', column: ['Odd layout', 'Mar 3, 2026', 'not json ['], linkedColumn: 9, locationsColumns: [2, 'x', 50] },
    ],
    pagingData: { totalCount: 8 },
  }, CFG);
  assert.equal(rawCount, 8);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'R&D Intern');
  assert.equal(rows[0].url, 'https://tas-hyatt.taleo.net/careersection/10780/jobdetail.ftl?job=777&lang=en');
  assert.equal(rows[0].location, 'US-TX-Austin; US-TX-Dallas');
  assert.equal(rows[0].postedAt, Date.UTC(2026, 9, 1));
  assert.equal(rows[1].title, 'Odd layout'); // out-of-range linkedColumn → column 0
  assert.equal(rows[1].location, 'not json [');
  assert.equal(rows[1].postedAt, Date.UTC(2026, 2, 3));
});

test('parseSearchResponse(): genuine zero result → empty; error envelopes / bad shapes → descriptive throw', () => {
  assert.equal(parseSearchResponse({ requisitionList: [], pagingData: { totalCount: 0 }, careerSectionUnAvailable: false }, CFG).rows.length, 0);
  assert.throws(() => parseSearchResponse({ requisitionList: null, pagingData: null, careerSectionUnAvailable: true }, CFG), /career section "10780" is unavailable/);
  assert.throws(() => parseSearchResponse({ requisitionList: { a: 1 }, pagingData: {} }, CFG), /requisitionList is object/);
  assert.throws(() => parseSearchResponse({ requisitionList: null, pagingData: { totalCount: 0 } }, CFG), /requisitionList is null/);
  assert.throws(() => parseSearchResponse({ error: 'boom', message: 'x' }, CFG), /unexpected search response shape \(keys: error, message\)/);
  assert.throws(() => parseSearchResponse({}, CFG), /keys: none/);
  for (const b of [null, [], 'x']) assert.throws(() => parseSearchResponse(b, CFG), /unexpected search response/);
});

test('findUsLocation(): lowest-level "United States" value, ignores junk', () => {
  assert.deepEqual(findUsLocation({ facetResults: US_FACETS }), { id: '1223', level: 1, quantity: 30 });
  assert.equal(findUsLocation({ facetResults: [{ id: 'LOCATION', facetValueResults: [{ id: '5', text: 'Texas', level: 2 }] }] }), null);
  assert.equal(findUsLocation({ facetResults: [{ id: 'LOCATION', facetValueResults: [null, { id: 7, text: 'United States' }] }] }), null);
  assert.equal(findUsLocation({}), null);
});

test('fetch(): normalized rows, POST + tz header + redirect:error on every request', async () => {
  const ctx = makeCtx([FIXTURE]);
  const jobs = await tl.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 3);
  assert.deepEqual(Object.keys(jobs[0]).sort(), ['company', 'location', 'postedAt', 'title', 'url']);
  assert.equal(jobs[0].company, 'Acme');
  assert.equal(ctx.calls.length, 1); // US value covers all → no refilter
  for (const c of ctx.calls) {
    assert.equal(c.opts.redirect, 'error');
    assert.equal(c.opts.method, 'POST');
    assert.ok(c.opts.headers.tz);
    assert.equal(new URL(c.url).hostname, 'tas-hyatt.taleo.net');
  }
});

test('fetch(): host/section guard throws before any request', async () => {
  for (const careers_url of ['https://evil.example/careersection/2/jobsearch.ftl', 'http://tas-hyatt.taleo.net/careersection/10780/x', 'https://epco.taleo.net/', 'nope']) {
    const ctx = makeCtx([FIXTURE]);
    await assert.rejects(() => tl.fetch({ name: 'Acme', careers_url }, ctx));
    assert.equal(ctx.calls.length, 0, careers_url);
  }
});

test('fetch(): zero result → []; unavailable section / unknown shape → throw', async () => {
  assert.deepEqual(await tl.fetch(ENTRY, makeCtx([page(0, 0, 0)])), []);
  await assert.rejects(() => tl.fetch(ENTRY, makeCtx([{ requisitionList: null, careerSectionUnAvailable: true }])), /unavailable/);
  await assert.rejects(() => tl.fetch(ENTRY, makeCtx([{ error: 'nope' }])), /unexpected search response shape/);
  await assert.rejects(() => tl.fetch(ENTRY, makeCtx([null])), /unexpected search response/);
});

test('fetch(): US facet present with other countries → refilters page 1 with it', async () => {
  const ctx = makeCtx([page(25, 0, 40, US_FACETS), page(25, 100, 30, US_FACETS), page(5, 125, 30, US_FACETS)]);
  const jobs = await tl.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 30);
  assert.deepEqual(ctx.calls.map((c) => c.body.filterSelectionParam.searchFilterSelections[0].selectedValues), [[], ['1223'], ['1223']]);
  assert.deepEqual(ctx.calls.map((c) => c.body.pageNo), [1, 1, 2]);
  assert.ok(jobs.every((j) => /Job 1\d\d/.test(j.title)));
});

test('fetch(): us_only:false skips the refilter', async () => {
  const ctx = makeCtx([page(25, 0, 40, US_FACETS), page(15, 25, 40)]);
  const jobs = await tl.fetch({ ...ENTRY, us_only: false }, ctx);
  assert.equal(jobs.length, 40);
  assert.equal(ctx.calls.length, 2);
});

test('fetch(): paginates by pageNo and stops at totalCount', async () => {
  const ctx = makeCtx([page(25, 1, 60), page(25, 26, 60), page(10, 51, 60), page(25, 999, 60)]);
  const jobs = await tl.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 60);
  assert.deepEqual(ctx.calls.map((c) => c.body.pageNo), [1, 2, 3]);
});

test('fetch(): a repeated page (no fresh rows) stops the walk', async () => {
  const ctx = makeCtx([page(25, 1, 1000), page(25, 1, 1000), page(25, 500, 1000)]);
  const jobs = await tl.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 25);
  assert.equal(ctx.calls.length, 2);
});

test('fetch(): DEFAULT_MAX_PAGES / max_pages ceiling stops an endless total, and warns', async () => {
  const warn = [];
  const orig = console.error;
  console.error = (m) => warn.push(String(m));
  try {
    const bodies = Array.from({ length: 200 }, (_, i) => page(25, i * 25, 1_000_000));
    const ctx = makeCtx(bodies);
    const jobs = await tl.fetch(ENTRY, ctx);
    assert.equal(ctx.calls.length, 100);
    assert.equal(jobs.length, 2500);
    assert.ok(warn.some((m) => /raise max_pages/.test(m)));

    const ctx2 = makeCtx(bodies);
    await tl.fetch({ ...ENTRY, max_pages: 3 }, ctx2);
    assert.equal(ctx2.calls.length, 3);

    const ctx3 = makeCtx(Array.from({ length: 500 }, (_, i) => page(25, i * 25, 1_000_000)));
    await tl.fetch({ ...ENTRY, max_pages: 99999 }, ctx3);
    assert.equal(ctx3.calls.length, 400); // MAX_PAGES_CAP
  } finally {
    console.error = orig;
  }
});

test('fetch(): page-2 failure keeps page 1 and warns, without the max_pages hint', async () => {
  const warn = [];
  const orig = console.error;
  console.error = (m) => warn.push(String(m));
  try {
    const err = Object.assign(new Error('HTTP 404'), { status: 404 });
    const jobs = await tl.fetch(ENTRY, makeCtx([page(25, 1, 100), err]));
    assert.equal(jobs.length, 25);
    assert.ok(warn.some((m) => /page 2 failed/.test(m)));
    assert.ok(!warn.some((m) => /raise max_pages/.test(m)));
  } finally {
    console.error = orig;
  }
});

test('fetch(): page-1 failure throws', async () => {
  await assert.rejects(() => tl.fetch(ENTRY, makeCtx([Object.assign(new Error('HTTP 403'), { status: 403 })])), /HTTP 403/);
});

test('fetch(): probe (ctx.maxPages:1) → exactly one request, no US refilter; rejection unwrapped', async () => {
  const ctx = makeCtx([page(25, 0, 400, US_FACETS), page(25, 25, 400)], { maxPages: 1 });
  const jobs = await tl.fetch(ENTRY, ctx);
  assert.equal(ctx.calls.length, 1);
  assert.equal(jobs.length, 25);

  class ProbePageBudgetReached extends Error {}
  const boom = new ProbePageBudgetReached('budget');
  // A spent budget throws on every later call too (retries included).
  await assert.rejects(() => tl.fetch(ENTRY, makeCtx([boom, boom, boom], { maxPages: 1 })), (e) => e === boom);

  const ctx2 = makeCtx([page(25, 0, 400), boom, boom, boom], { maxPages: 2 });
  await assert.rejects(() => tl.fetch(ENTRY, ctx2), (e) => e === boom);
});

test('regression: a malformed LOCATION facet is ignored, never loses the batch', async () => {
  // review 2 #1: quantity as an object threw "Cannot convert object to primitive value"
  const bad = { id: '123', text: 'United States', quantity: { toString: null, valueOf: null }, level: 1 };
  const facets = [{ id: 'LOCATION', facetValueResults: [bad, { id: '1038', text: 'Canada', quantity: '10', level: 1 }] }];
  assert.equal(findUsLocation({ facetResults: facets }), null);
  for (const q of [null, undefined, '12abc', -3, 1.5, [], true]) {
    assert.equal(findUsLocation({ facetResults: [{ id: 'LOCATION', facetValueResults: [{ ...bad, quantity: q }] }] }), null, String(q));
  }
  assert.equal(findUsLocation({ facetResults: [{ id: 'LOCATION', facetValueResults: [{ ...bad, level: { valueOf: null } , quantity: '5' }] }] }), null);
  // a bad facet next to a good one: the good one still wins
  const good = { id: '1223', text: 'United States', quantity: 30, level: 2 };
  assert.deepEqual(findUsLocation({ facetResults: [{ id: 'LOCATION', facetValueResults: [bad, good] }] }), { id: '1223', level: 2, quantity: 30 });
  // fetch() keeps the valid row and does not refilter on the bad facet
  const ctx = makeCtx([page(1, 1, 1, facets)]);
  const jobs = await tl.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 1);
  assert.equal(ctx.calls.length, 1);
});
