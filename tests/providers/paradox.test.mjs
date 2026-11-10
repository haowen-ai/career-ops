// tests/providers/paradox.test.mjs — Paradox career sites (careers.fedex.com,
// dardenrscjobs.recruiting.com): session-cookie GET + POST /api/get-jobs.
//
// The fixture is a trimmed live response (2026-11-07): two FedEx rows with
// relative originalURL and one Darden row with an absolute paradox.ai URL.
// No network is used — ctx is stubbed.
//
// Run:  node --test tests/providers/paradox.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/paradox.mjs')).href);
const px = mod.default;
const { resolveConfig, buildListUrl, parseJobsResponse, cookieHeader, readRequestBody } = mod;

const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/paradox-get-jobs.json'), 'utf8'));
const URL_US = 'https://careers.fedex.com/jobs?filter%5Bcountry%5D%5B0%5D=United%20States';
const ENTRY = { name: 'Acme', careers_url: URL_US };
const CFG = resolveConfig(ENTRY);
const SHELL = '<html><script>window.__PRELOAD_STATE__ = {"company":{"site_available_languages":["en","es"],"page_attributes":{"disable_switch_search_mode":true}}};</script></html>';

/** Synthetic page of `n` rows starting at id `start`, reporting `total`. */
function page(n, start, total) {
  return {
    totalJob: total,
    facets: [],
    jobs: Array.from({ length: n }, (_, i) => ({
      uniqueID: `U${start + i}`,
      title: `Job ${start + i}`,
      originalURL: `job-${start + i}/job/P${start + i}`,
      locations: [{ city: 'Memphis', stateAbbr: 'TN', countryAbbr: 'US' }],
    })),
  };
}

function makeCtx(bodies, extra = {}) {
  const calls = [];
  const gets = [];
  let i = 0;
  return {
    calls,
    gets,
    sleep: async () => {},
    fetchResponse: async (url, opts) => {
      gets.push({ url, opts });
      return { headers: { getSetCookie: () => ['ct=s%3Aabc.def; Path=/; HttpOnly; Secure', 'gone=; Max-Age=0'] }, text: async () => SHELL };
    },
    fetchJson: async (url, opts) => {
      calls.push({ url, opts });
      const b = bodies[i++];
      if (b instanceof Error) throw b;
      return b === undefined ? { jobs: [], totalJob: 0 } : b;
    },
    ...extra,
  };
}

test('id; detect() never claims an entry (explicit provider only)', () => {
  assert.equal(px.id, 'paradox');
  assert.equal(px.detect({ careers_url: URL_US }), null);
});

test('resolveConfig(): https only, forwards filter[...]/keyword, defaults path to /jobs', () => {
  assert.deepEqual(CFG.forward, [['filter[country][0]', 'United States']]);
  assert.equal(CFG.origin, 'https://careers.fedex.com');
  assert.equal(resolveConfig({ careers_url: 'https://dardenrscjobs.recruiting.com' }).pageUrl, 'https://dardenrscjobs.recruiting.com/jobs');
  assert.deepEqual(resolveConfig({ careers_url: 'https://careers.fedex.com/jobs?keyword=intern&utm_source=a' }).forward, [['keyword', 'intern']]);
  for (const bad of ['http://careers.fedex.com/jobs', 'nope', '', 'https://u:p@careers.fedex.com/jobs']) {
    assert.throws(() => resolveConfig({ careers_url: bad }), undefined, bad);
  }
});

test('buildListUrl(): same origin, 1-based page_number, page_size 100, filters appended', () => {
  const u = new URL(buildListUrl(CFG, 3));
  assert.equal(u.origin + u.pathname, 'https://careers.fedex.com/api/get-jobs');
  assert.equal(u.searchParams.get('page_number'), '3');
  assert.equal(u.searchParams.get('page_size'), '100');
  assert.equal(u.searchParams.get('filter[country][0]'), 'United States');
});

test('cookieHeader() keeps ct, drops deleted cookies; readRequestBody() mirrors the site', () => {
  assert.equal(cookieHeader(['ct=a; Path=/', 'x=; Max-Age=0', 7, 'bad']), 'ct=a');
  assert.deepEqual(readRequestBody(SHELL), { disable_switch_search_mode: true, site_available_languages: ['en', 'es'] });
  assert.deepEqual(readRequestBody('<html></html>'), {});
  assert.deepEqual(readRequestBody(null), {});
});

test('parseJobsResponse(): real fixture rows (relative and absolute posting URLs)', () => {
  const { rows, total, rawCount } = parseJobsResponse(FIXTURE, CFG);
  assert.equal(total, 3);
  assert.equal(rawCount, 3);
  assert.equal(rows[0].title, 'Straight Truck Driver DOT-1');
  assert.equal(rows[0].url, 'https://careers.fedex.com/straight-truck-driver-dot-1/job/P25-363956-4');
  assert.equal(rows[0].location, 'Louisville, KY');
  assert.match(rows[2].url, /^https:\/\/darden\.paradox\.ai\/co\/DardenRestaurantSupportCenter\/Job\?job_id=/);
  assert.equal(rows[2].location, 'Orlando, FL');
});

test('parseJobsResponse(): malformed rows skipped, foreign hosts rejected, non-US country appended', () => {
  const { rows } = parseJobsResponse({
    totalJob: 6,
    jobs: [
      null,
      { uniqueID: 'a', title: '', originalURL: 'x/job/1' },
      { uniqueID: 'b', title: { not: 'a string' }, originalURL: 'x/job/2' },
      { uniqueID: 'c', title: 'Evil', originalURL: 'https://evil.example/job/3', applyURL: 'javascript:alert(1)' },
      { uniqueID: 'd', title: 'R&amp;D Intern', originalURL: 'https://evil.example/', applyURL: 'https://fedex.paradox.ai/co/X/Job?job_id=4', locations: [{ city: 'Toronto', stateAbbr: 'ON', countryAbbr: 'CA', country: 'Canada' }, {}] },
      { title: 'No id', originalURL: 7, applyURL: 'r/job/5', locations: 'nope' },
    ],
  }, CFG);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'R&D Intern');
  assert.equal(rows[0].url, 'https://fedex.paradox.ai/co/X/Job?job_id=4');
  assert.equal(rows[0].location, 'Toronto, ON, Canada (+1 more)');
  assert.equal(rows[1].url, 'https://careers.fedex.com/r/job/5');
  assert.equal(rows[1].id, 'https://careers.fedex.com/r/job/5');
  assert.equal(rows[1].location, '');
});

test('parseJobsResponse(): genuine zero → empty; envelopes / non-array / wrong type → throw', () => {
  assert.equal(parseJobsResponse({ jobs: [], facets: [], totalJob: 0 }, CFG).rows.length, 0);
  assert.throws(() => parseJobsResponse(null, CFG), /returned null/);
  assert.throws(() => parseJobsResponse([], CFG), /returned an array/);
  assert.throws(() => parseJobsResponse('Access Denied', CFG), /returned string/);
  assert.throws(() => parseJobsResponse({ error: 'Internal Server Error' }, CFG), /jobs is missing; keys: error/);
  assert.throws(() => parseJobsResponse({ jobs: { a: 1 }, totalJob: 1 }, CFG), /jobs is not an array/);
});

test('fetch(): GET page for the cookie, then POST with cookie + referer + redirect:error', async () => {
  const ctx = makeCtx([FIXTURE]);
  const jobs = await px.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 3);
  assert.deepEqual(Object.keys(jobs[0]).sort(), ['company', 'location', 'title', 'url']);
  assert.equal(ctx.gets.length, 1);
  assert.equal(ctx.gets[0].url, URL_US);
  assert.equal(ctx.gets[0].opts.redirect, 'error');
  assert.equal(ctx.calls.length, 1);
  const o = ctx.calls[0].opts;
  assert.equal(o.method, 'POST');
  assert.equal(o.redirect, 'error');
  assert.equal(o.headers.cookie, 'ct=s%3Aabc.def');
  assert.equal(o.headers.referer, URL_US);
  assert.deepEqual(JSON.parse(o.body), { disable_switch_search_mode: true, site_available_languages: ['en', 'es'] });
});

test('fetch(): bad URL throws before any request', async () => {
  for (const careers_url of ['http://careers.fedex.com/jobs', 'nope']) {
    const ctx = makeCtx([FIXTURE]);
    await assert.rejects(() => px.fetch({ name: 'Acme', careers_url }, ctx));
    assert.equal(ctx.gets.length + ctx.calls.length, 0, careers_url);
  }
});

test('fetch(): no ct cookie → descriptive throw, no list request', async () => {
  const ctx = makeCtx([FIXTURE], { fetchResponse: async () => ({ headers: { getSetCookie: () => [] }, text: async () => '' }) });
  await assert.rejects(() => px.fetch(ENTRY, ctx), /issued no session cookie/);
  assert.equal(ctx.calls.length, 0);
});

test('fetch(): error envelope on page 1 throws instead of returning []', async () => {
  await assert.rejects(() => px.fetch(ENTRY, makeCtx([{ message: 'nope' }])), /unexpected get-jobs response/);
  assert.deepEqual(await px.fetch(ENTRY, makeCtx([{ jobs: [], totalJob: 0 }])), []);
});

test('fetch(): pages by the size the server applied and stops at totalJob despite a short mid page', async () => {
  // Server ignores page_size=100 and serves 10/page; page 2 is short (9) mid-list.
  const ctx = makeCtx([page(10, 1, 30), page(9, 11, 30), page(10, 21, 30), page(10, 99, 30)]);
  const jobs = await px.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 29);
  assert.deepEqual(ctx.calls.map((c) => new URL(c.url).searchParams.get('page_number')), ['1', '2', '3']);
});

test('fetch(): max_pages ceiling stops an endless total, and warns', async () => {
  const pages = Array.from({ length: 80 }, (_, p) => page(100, p * 100 + 1, 9_999_999));
  const warnings = [];
  const real = console.error;
  console.error = (m) => warnings.push(String(m));
  try {
    const ctx = makeCtx(pages);
    await px.fetch(ENTRY, ctx);
    assert.equal(ctx.calls.length, 60);
    const ctx2 = makeCtx(pages);
    await px.fetch({ ...ENTRY, max_pages: 2 }, ctx2);
    assert.equal(ctx2.calls.length, 2);
    assert.ok(warnings.some((w) => /raise max_pages/.test(w)));
  } finally {
    console.error = real;
  }
});

test('fetch(): ctx.maxPages=1 → one list request; probe rejection propagates unwrapped', async () => {
  const ctx = makeCtx([page(100, 1, 500), page(100, 101, 500)], { maxPages: 1 });
  assert.equal((await px.fetch(ENTRY, ctx)).length, 100);
  assert.equal(ctx.calls.length, 1);
  class ProbePageBudgetReached extends Error {}
  const err = new ProbePageBudgetReached('budget');
  await assert.rejects(() => px.fetch(ENTRY, makeCtx([err, err, err], { maxPages: 1 })), (e) => e === err);
});

test('fetch(): page-2 failure keeps page 1 and does not claim truncation', async () => {
  const busy = Object.assign(new Error('HTTP 503'), { status: 503 });
  const warnings = [];
  const real = console.error;
  console.error = (m) => warnings.push(String(m));
  try {
    const jobs = await px.fetch(ENTRY, makeCtx([page(100, 1, 300), busy, busy, busy]));
    assert.equal(jobs.length, 100);
    assert.ok(warnings.some((w) => /page 2 failed/.test(w)));
    assert.equal(warnings.filter((w) => /raise max_pages/.test(w)).length, 0);
  } finally {
    console.error = real;
  }
});

test('fetch(): first-page HTTP error throws', async () => {
  const denied = Object.assign(new Error('HTTP 403 Forbidden'), { status: 403 });
  await assert.rejects(() => px.fetch(ENTRY, makeCtx([denied])), /403/);
});

test('regression: hostname allowlist — a host outside it throws before any request', async () => {
  // review 2 #3: https://evil.example/jobs used to be fetched (GET page + POST /api/get-jobs)
  for (const careers_url of ['https://evil.example/jobs', 'https://careers.fedex.com.evil.example/jobs', 'https://evil.recruiting.com/jobs',
    'https://fedex.paradox.ai/jobs', 'https://careers.fedex.com:8443/jobs', 'https://127.0.0.1/jobs']) {
    assert.throws(() => resolveConfig({ careers_url }), /not in the allowlist/, careers_url);
    const ctx = makeCtx([page(1, 1, 1)]);
    await assert.rejects(() => px.fetch({ name: 'X', careers_url }, ctx), /not in the allowlist/);
    assert.equal(ctx.gets.length + ctx.calls.length, 0, careers_url);
  }
  assert.deepEqual([...mod.ALLOWED_HOSTS].sort(), ['careers.fedex.com', 'dardenrscjobs.recruiting.com']);
  assert.equal(resolveConfig({ careers_url: 'https://CAREERS.FEDEX.COM/jobs' }).host, 'careers.fedex.com');
});
