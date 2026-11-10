// tests/providers/slb.test.mjs — SLB careers (Coveo Atomic search behind
// careers.slb.com/job-listing).
//
// Fixtures: a minimal job-listing page carrying the hidden Coveo settings
// (the access key is a dummy, not the live one) and a trimmed live search
// response (2026-11-07, 3 of 327 US rows: one Workday/ChampionX WDR id, one
// Eightfold EF id, one intern). No network — ctx is stubbed.
//
// Run:  node --test tests/providers/slb.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/slb.mjs')).href);
const slb = mod.default;
const { resolveConfig, extractCoveoSettings, buildSearchRequest, parseSearchResponse } = mod;

const PAGE = readFileSync(join(ROOT, 'tests/fixtures/slb-job-listing.html'), 'utf8');
const SEARCH = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/slb-search.json'), 'utf8'));
const US_URL = 'https://careers.slb.com/job-listing#f-country-job=United%20States';
const ENTRY = { name: 'SLB', careers_url: US_URL };
const SEARCH_URL = 'https://schlumbergerproduction0cs2zrh7.org.coveo.com/rest/search/v2?organizationId=schlumbergerproduction0cs2zrh7';

/** Synthetic Coveo page of `n` results starting at `start`, reporting `total`. */
function results(n, start, total) {
  return {
    totalCount: total,
    results: Array.from({ length: n }, (_, i) => ({
      title: `Job ${start + i}`,
      clickUri: `https://careers.slb.com/jobdescription.aspx?id=EF${start + i}-en_US 1`,
      raw: { city: 'Houston', country: ['United States'], jobposteddate: 1793000000000 },
    })),
  };
}

function makeCtx(searchBodies, extra = {}) {
  const calls = [];
  let i = 0;
  return {
    calls,
    sleep: async () => {},
    fetchText: async (url, opts) => {
      calls.push({ kind: 'text', url, opts });
      return PAGE;
    },
    fetchJson: async (url, opts) => {
      calls.push({ kind: 'json', url, opts, body: JSON.parse(opts.body) });
      const b = searchBodies[i++];
      if (b instanceof Error) throw b;
      if (b === undefined) throw new Error('unexpected extra search request');
      return b;
    },
    ...extra,
  };
}

test('id', () => {
  assert.equal(slb.id, 'slb');
});

test('detect(): claims only https careers.slb.com', () => {
  assert.deepEqual(slb.detect(ENTRY), { url: US_URL });
  for (const bad of ['http://careers.slb.com/job-listing', 'https://evil.example/job-listing', 'https://careers.slb.com.evil.example/', 'nope', '']) {
    assert.equal(slb.detect({ careers_url: bad }), null, bad);
  }
  assert.equal(slb.detect({}), null);
  assert.equal(slb.detect({ careers_url: 7 }), null);
  assert.equal(slb.detect(null), null);
});

test('resolveConfig(): country/category/q from hash or query, like the page JS', () => {
  assert.deepEqual(resolveConfig(ENTRY), { countries: ['United States'], categories: [], q: '' });
  assert.deepEqual(resolveConfig({ careers_url: 'https://careers.slb.com/job-listing?f-country-job=United%20States,Canada&q=intern' }), { countries: ['United States', 'Canada'], categories: [], q: 'intern' });
  assert.deepEqual(resolveConfig({ careers_url: 'https://careers.slb.com/job-listing' }), { countries: [], categories: [], q: '' });
});

test('extractCoveoSettings(): reads hidden inputs + pipeline; missing/odd values throw', () => {
  const s = extractCoveoSettings(PAGE);
  assert.equal(s.orgId, 'schlumbergerproduction0cs2zrh7');
  assert.equal(s.searchHub, 'CoveoJobsHub');
  assert.equal(s.source, 'ATS_Jobs_Source - Prod');
  assert.equal(s.pipeline, 'ATSJobsPipeline');
  assert.throws(() => extractCoveoSettings('<html>Access Denied</html>'), /Coveo settings not found .*organizationId:missing/);
  assert.throws(() => extractCoveoSettings(PAGE.replace('schlumbergerproduction0cs2zrh7', 'evil.example/x')), /organizationId format/);
  assert.throws(() => extractCoveoSettings(null), /not text/);
});

test('buildSearchRequest(): Coveo host from org id, source cq, country aq', () => {
  const req = buildSearchRequest(extractCoveoSettings(PAGE), resolveConfig(ENTRY), 200);
  assert.equal(req.url, SEARCH_URL);
  assert.equal(req.body.cq, '@source=="ATS_Jobs_Source - Prod"');
  assert.equal(req.body.aq, '@country==("United States")');
  assert.equal(req.body.firstResult, 200);
  assert.equal(req.body.searchHub, 'CoveoJobsHub');
  assert.equal(req.body.pipeline, 'ATSJobsPipeline');
  const all = buildSearchRequest(extractCoveoSettings(PAGE), resolveConfig({ careers_url: 'https://careers.slb.com/job-listing' }), 0);
  assert.equal(all.body.aq, undefined);
});

test('parseSearchResponse(): real fixture rows (Workday + Eightfold ids)', () => {
  const { rows, total, rawCount } = parseSearchResponse(SEARCH);
  assert.equal(total, 3);
  assert.equal(rawCount, 3);
  assert.equal(rows[0].title, 'Local HazMat CDL Driver');
  assert.equal(rows[0].url, 'https://careers.slb.com/jobdescription.aspx?id=WDR00136646');
  assert.equal(rows[0].location, 'Vernal, United States');
  assert.equal(rows[0].postedAt, 1793865600000);
  assert.match(rows[1].url, /id=EF\d+-en_US%201$/);
  assert.ok(rows.some((r) => /Intern/.test(r.title)));
});

test('parseSearchResponse(): malformed records skipped, entities decoded', () => {
  const { rows } = parseSearchResponse({
    totalCount: 6,
    results: [
      null,
      { title: 7, clickUri: 'https://careers.slb.com/jobdescription.aspx?id=1' },
      { title: 'No uri' },
      { title: 'Foreign', clickUri: 'https://evil.example/jobdescription.aspx?id=2' },
      { title: 'Bad uri', clickUri: 'not a url' },
      { title: 'R&amp;D Intern', clickUri: 'https://careers.slb.com/jobdescription.aspx?id=3', raw: { city: ['Houston'], country: 'United States', jobposteddate: 'x' } },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'R&D Intern');
  assert.equal(rows[0].location, 'Houston, United States');
  assert.equal(rows[0].postedAt, undefined);
});

test('parseSearchResponse(): results:[] → empty; error envelope / non-array / non-object → throw', () => {
  assert.equal(parseSearchResponse({ totalCount: 0, results: [] }).rows.length, 0);
  assert.throws(() => parseSearchResponse({ statusCode: 419, message: 'Expired token', type: 'ExpiredTokenException' }), /unexpected Coveo response \(Expired token\)/);
  assert.throws(() => parseSearchResponse({ totalCount: 1, results: {} }), /results is not an array/);
  assert.throws(() => parseSearchResponse(null), /unexpected Coveo response \(null\)/);
  assert.throws(() => parseSearchResponse([]), /unexpected Coveo response \(array\)/);
});

test('fetch(): settings page then POST search; redirect:error on every request; bearer key from page', async () => {
  const ctx = makeCtx([SEARCH]);
  const jobs = await slb.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 3);
  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.calls[0].url, 'https://careers.slb.com/job-listing');
  assert.equal(ctx.calls[1].url, SEARCH_URL);
  assert.equal(ctx.calls[1].opts.method, 'POST');
  assert.equal(ctx.calls[1].opts.headers.authorization, 'Bearer xx00000000-0000-0000-0000-000000000000');
  for (const c of ctx.calls) assert.equal(c.opts.redirect, 'error');
  assert.deepEqual(Object.keys(jobs[0]).sort(), ['company', 'location', 'postedAt', 'title', 'url']);
  assert.equal(jobs[0].company, 'SLB');
});

test('fetch(): host guard throws before any request', async () => {
  for (const careers_url of ['https://evil.example/job-listing', 'http://careers.slb.com/job-listing', 'nope']) {
    const ctx = makeCtx([SEARCH]);
    await assert.rejects(() => slb.fetch({ name: 'X', careers_url }, ctx));
    assert.equal(ctx.calls.length, 0, careers_url);
  }
});

test('fetch(): zero results → []; error envelope → throw', async () => {
  assert.deepEqual(await slb.fetch(ENTRY, makeCtx([{ totalCount: 0, results: [] }])), []);
  await assert.rejects(() => slb.fetch(ENTRY, makeCtx([{ statusCode: 401, message: 'Unauthorized' }])), /Unauthorized/);
});

test('fetch(): paginates by firstResult and stops at totalCount', async () => {
  const ctx = makeCtx([results(200, 1, 450), results(200, 201, 450), results(50, 401, 450)]);
  const jobs = await slb.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 450);
  assert.deepEqual(ctx.calls.filter((c) => c.kind === 'json').map((c) => c.body.firstResult), [0, 200, 400]);
});

test('fetch(): DEFAULT_MAX_PAGES / max_pages caps the walk and warns', async () => {
  const errs = [];
  const orig = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    const bodies = Array.from({ length: 12 }, (_, p) => results(200, p * 200 + 1, 999999));
    const ctx = makeCtx(bodies);
    const jobs = await slb.fetch(ENTRY, ctx);
    assert.equal(ctx.calls.filter((c) => c.kind === 'json').length, 10);
    assert.equal(jobs.length, 2000);
    const ctx2 = makeCtx(bodies);
    await slb.fetch({ ...ENTRY, max_pages: 2 }, ctx2);
    assert.equal(ctx2.calls.filter((c) => c.kind === 'json').length, 2);
  } finally {
    console.error = orig;
  }
  assert.ok(errs.some((m) => /truncated at 2000 of 999999.*raise max_pages/.test(m)));
});

test('fetch(): page-2 failure keeps page 1 and does not claim truncation', async () => {
  const errs = [];
  const orig = console.error;
  console.error = (m) => errs.push(String(m));
  const fail = Object.assign(new Error('HTTP 400'), { status: 400 });
  try {
    const jobs = await slb.fetch(ENTRY, makeCtx([results(200, 1, 450), fail]));
    assert.equal(jobs.length, 200);
  } finally {
    console.error = orig;
  }
  assert.ok(errs.some((m) => /page 2 failed/.test(m)));
  assert.ok(!errs.some((m) => /raise max_pages/.test(m)));
});

test('fetch(): probe (ctx.maxPages=1) → one search request; rejection propagates unwrapped', async () => {
  const ctx = makeCtx([results(200, 1, 450)], { maxPages: 1 });
  await slb.fetch(ENTRY, ctx);
  assert.equal(ctx.calls.filter((c) => c.kind === 'json').length, 1);
  class ProbePageBudgetReached extends Error {}
  const err = new ProbePageBudgetReached('budget');
  await assert.rejects(() => slb.fetch(ENTRY, makeCtx([err, err, err], { maxPages: 1 })), (e) => e === err);
});
