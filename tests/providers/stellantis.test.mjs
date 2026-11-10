// tests/providers/stellantis.test.mjs — Stellantis careers (Symphony Talent
// m-cloud / jobsapi-google job/search).
//
// The fixture is a trimmed live response (2026-11-07, 3 of 412 US rows);
// no network is used — ctx is stubbed.
//
// Run:  node --test tests/providers/stellantis.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/stellantis.mjs')).href);
const st = mod.default;
const { resolveConfig, buildSearchUrl, parseSearchResponse } = mod;

const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/stellantis-search.json'), 'utf8'));
const URL_US = 'https://careers.stellantis.com/job-search-results/?primary_country=US';
const ENTRY = { name: 'Acme', careers_url: URL_US };

/** Synthetic page of `n` rows starting at id `start`, reporting `total`. */
function page(n, start, total) {
  return {
    totalHits: total,
    searchResults: Array.from({ length: n }, (_, i) => ({
      job: { id: start + i, title: `Job ${start + i}`, primary_city: 'Town', primary_state: 'MI', open_date: '2026-11-01T00:00:00', url: `https://careers.stellantis.com/job/${start + i}/job/` },
    })),
  };
}

function makeCtx(bodies, extra = {}) {
  const calls = [];
  let i = 0;
  return {
    calls,
    sleep: async () => {},
    fetchJson: async (url, opts) => {
      calls.push({ url, opts });
      const b = bodies[i++];
      if (b instanceof Error) throw b;
      return b === undefined ? { totalHits: 0, searchResults: [] } : b;
    },
    ...extra,
  };
}

test('id', () => {
  assert.equal(st.id, 'stellantis');
});

test('detect(): claims only https careers.stellantis.com', () => {
  assert.deepEqual(st.detect({ careers_url: URL_US }), { url: URL_US });
  for (const bad of ['http://careers.stellantis.com/', 'https://evil.example/?primary_country=US', 'https://careers.stellantis.com.evil.example/', 'nope', '']) {
    assert.equal(st.detect({ careers_url: bad }), null, bad);
  }
  assert.equal(st.detect({}), null);
  assert.equal(st.detect({ careers_url: 7 }), null);
  assert.equal(st.detect(null), null);
});

test('resolveConfig(): country facet → customAttributeFilter like the site JS', () => {
  assert.equal(resolveConfig(ENTRY).customAttributeFilter, 'country="US"');
  assert.equal(resolveConfig({ careers_url: 'https://careers.stellantis.com/job-search-results/' }).customAttributeFilter, '');
  assert.equal(resolveConfig({ careers_url: 'https://careers.stellantis.com/x/?primary_country=US&primary_state=MI' }).customAttributeFilter, 'country_state="US, MI"');
  assert.equal(resolveConfig({ careers_url: 'https://careers.stellantis.com/x/?primary_country=Algeria' }).customAttributeFilter, 'country_state_city="Algeria"');
  const c = resolveConfig({ careers_url: 'https://careers.stellantis.com/x/?primary_country=US&primary_category=Engineering~Design&keyword=intern' });
  assert.equal(c.customAttributeFilter, 'country="US" AND (primary_category="Engineering" OR primary_category="Design")');
  assert.equal(c.query, 'intern');
  assert.equal(c.companyName, 'companies/16115603-6c1b-4c45-b544-238a4e6c51b3');
});

test('buildSearchUrl(): fixed API host, companyName, pageSize 100, 0-based offset', () => {
  const u = new URL(buildSearchUrl(resolveConfig(ENTRY), 200));
  assert.equal(u.origin + u.pathname, 'https://jobsapi-google.m-cloud.io/api/job/search');
  assert.equal(u.searchParams.get('companyName'), 'companies/16115603-6c1b-4c45-b544-238a4e6c51b3');
  assert.equal(u.searchParams.get('pageSize'), '100');
  assert.equal(u.searchParams.get('offset'), '200');
  assert.equal(u.searchParams.get('customAttributeFilter'), 'country="US"');
});

test('parseSearchResponse(): real fixture rows', () => {
  const { rows, total, rawCount } = parseSearchResponse(FIXTURE);
  assert.equal(total, 3);
  assert.equal(rawCount, 3);
  assert.equal(rows[0].title, 'Base Engine Calibration Specialist');
  assert.equal(rows[0].url, 'https://careers.stellantis.com/job/24114862/base-engine-calibration-specialist-auburn-hills-mi/');
  assert.equal(rows[0].location, 'Auburn Hills, MI');
  assert.equal(rows[0].postedAt, Date.UTC(2026, 10, 5, 16, 2, 21));
  assert.ok(rows.some((r) => /Co-Op/.test(r.title)));
});

test('parseSearchResponse(): bad rows dropped, foreign url falls back to /job/{id}/, entities decoded', () => {
  const { rows } = parseSearchResponse({
    totalHits: 4,
    searchResults: [
      { job: { id: 1, title: '', url: 'https://careers.stellantis.com/job/1/x/' } },
      { job: { title: 'No id, no url' } },
      { job: { id: 3, title: 'R&amp;D Intern', url: 'https://evil.example/job/3/', primary_country: 'CA', open_date: 'garbage' } },
      null,
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'R&D Intern');
  assert.equal(rows[0].url, 'https://careers.stellantis.com/job/3/');
  assert.equal(rows[0].location, 'CA');
  assert.equal(rows[0].postedAt, undefined);
});

test('parseSearchResponse(): empty bodies → empty; unknown shape → descriptive throw', () => {
  for (const b of [null, {}, [], 'x', { totalHits: 0, searchResults: null }]) {
    assert.equal(parseSearchResponse(b).rows.length, 0);
  }
  assert.throws(() => parseSearchResponse({ jobs: [], count: 0 }), /unexpected search response shape \(keys: jobs, count\)/);
});

test('fetch(): normalized rows, redirect:error on every request', async () => {
  const ctx = makeCtx([FIXTURE]);
  const jobs = await st.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 3);
  assert.deepEqual(Object.keys(jobs[0]).sort(), ['company', 'location', 'postedAt', 'title', 'url']);
  assert.equal(jobs[0].company, 'Acme');
  assert.equal(ctx.calls.length, 1);
  for (const c of ctx.calls) assert.equal(c.opts.redirect, 'error');
});

test('fetch(): host guard throws before any request', async () => {
  for (const careers_url of ['https://evil.example/?primary_country=US', 'http://careers.stellantis.com/', 'nope']) {
    const ctx = makeCtx([FIXTURE]);
    await assert.rejects(() => st.fetch({ name: 'Acme', careers_url }, ctx));
    assert.equal(ctx.calls.length, 0, careers_url);
  }
});

test('fetch(): empty body → []; unknown shape → throw', async () => {
  assert.deepEqual(await st.fetch(ENTRY, makeCtx([{}])), []);
  assert.deepEqual(await st.fetch(ENTRY, makeCtx([null])), []);
  await assert.rejects(() => st.fetch(ENTRY, makeCtx([{ error: 'nope' }])), /unexpected search response shape/);
});

test('fetch(): paginates by offset and stops at totalHits', async () => {
  const ctx = makeCtx([page(100, 1, 250), page(100, 101, 250), page(50, 201, 250)]);
  const jobs = await st.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 250);
  assert.deepEqual(ctx.calls.map((c) => new URL(c.url).searchParams.get('offset')), ['0', '100', '200']);
});

test('fetch(): DEFAULT_MAX_PAGES / max_pages ceiling stops an endless total, and warns', async () => {
  const pages = Array.from({ length: 40 }, (_, p) => page(100, p * 100 + 1, 9_999_999));
  const warnings = [];
  const real = console.error;
  console.error = (m) => warnings.push(String(m));
  try {
    const ctx = makeCtx(pages);
    const jobs = await st.fetch(ENTRY, ctx);
    assert.equal(ctx.calls.length, 20);
    assert.equal(jobs.length, 2000);
    const ctx2 = makeCtx(pages);
    await st.fetch({ ...ENTRY, max_pages: 3 }, ctx2);
    assert.equal(ctx2.calls.length, 3);
    assert.ok(warnings.some((w) => /raise max_pages/.test(w)));
  } finally {
    console.error = real;
  }
});

test('fetch(): ctx.maxPages=1 → exactly one request, no truncation warning', async () => {
  const warnings = [];
  const real = console.error;
  console.error = (m) => warnings.push(String(m));
  try {
    const ctx = makeCtx([page(100, 1, 500), page(100, 101, 500)], { maxPages: 1 });
    const jobs = await st.fetch(ENTRY, ctx);
    assert.equal(ctx.calls.length, 1);
    assert.equal(jobs.length, 100);
    assert.equal(warnings.filter((w) => /raise max_pages/.test(w)).length, 0);
  } finally {
    console.error = real;
  }
});

test('fetch(): a probe-time rejection propagates unwrapped', async () => {
  class ProbePageBudgetReached extends Error {}
  const err = new ProbePageBudgetReached('budget');
  const ctx = makeCtx([err, err, err], { maxPages: 1 }); // the real probe keeps throwing on retries
  await assert.rejects(() => st.fetch(ENTRY, ctx), (e) => e === err);
});

test('fetch(): page-2 429 that retry cannot clear keeps page 1 and does not claim truncation', async () => {
  const busy = Object.assign(new Error('HTTP 429'), { status: 429 });
  const warnings = [];
  const real = console.error;
  console.error = (m) => warnings.push(String(m));
  try {
    const ctx = makeCtx([page(100, 1, 300), busy, busy, busy]);
    const jobs = await st.fetch(ENTRY, ctx);
    assert.equal(jobs.length, 100);
    assert.equal(ctx.calls.length, 4); // page 1 + 3 attempts on page 2
    assert.ok(warnings.some((w) => /page 2 failed/.test(w)));
    assert.equal(warnings.filter((w) => /raise max_pages/.test(w)).length, 0);
  } finally {
    console.error = real;
  }
});

test('fetch(): a first-page failure throws (unreachable, not empty)', async () => {
  const bad = Object.assign(new Error('HTTP 400'), { status: 400 });
  await assert.rejects(() => st.fetch(ENTRY, makeCtx([bad])), /400/);
});
