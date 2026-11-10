// tests/providers/dayforce.test.mjs — Dayforce candidate portal
// (next-auth CSRF bootstrap + /api/geo/{ns}/jobposting/search).
//
// The fixture is a trimmed live response (2026-11-07, 3 of 186 rows for
// ibgllc/CANDIDATEPORTAL; descriptions cut). No network — ctx is stubbed.
//
// Run:  node --test tests/providers/dayforce.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/dayforce.mjs')).href);
const df = mod.default;
const { resolveConfig, parseSearchResponse } = mod;

const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/dayforce-search.json'), 'utf8'));
const URL_BASE = 'https://jobs.dayforcehcm.com/en-US/ibgllc/CANDIDATEPORTAL';
const ENTRY = { name: 'Acme', careers_url: URL_BASE };
const CFG = { ns: 'ibgllc', site: 'CANDIDATEPORTAL', locale: 'en-US', country: null };

function csrfResponse({ token = 'a'.repeat(64), cookies = ['__Host-next-auth.csrf-token=abc%7Cdef; Path=/; HttpOnly; Secure', '__cf_bm=zzz; path=/'] } = {}) {
  const h = new Headers({ 'content-type': 'application/json' });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(JSON.stringify({ csrfToken: token }), { status: 200, headers: h });
}

/** Synthetic page of `n` postings starting at id `start`, reporting `total`. */
function page(n, start, total, country = 'US') {
  return {
    maxCount: total,
    offset: 0,
    count: n,
    jobPostings: Array.from({ length: n }, (_, i) => ({
      jobPostingId: start + i,
      jobTitle: `Job ${start + i}`,
      postingStartTimestampUTC: '2026-11-01T00:00:00+00:00',
      postingLocations: [{ formattedAddress: 'Town, ST, USA', isoCountryCode: country }],
    })),
  };
}

function makeCtx(bodies, extra = {}) {
  const calls = [];
  const boot = [];
  let i = 0;
  return {
    calls,
    boot,
    sleep: async () => {},
    fetchResponse: async (url, opts) => {
      boot.push({ url, opts });
      return csrfResponse();
    },
    fetchJson: async (url, opts) => {
      calls.push({ url, opts });
      const b = bodies[i++];
      if (b instanceof Error) throw b;
      return b === undefined ? { jobPostings: [], maxCount: 0 } : b;
    },
    ...extra,
  };
}

test('id', () => {
  assert.equal(df.id, 'dayforce');
});

test('detect(): claims only https jobs.dayforcehcm.com/{locale?}/{ns}/{site}', () => {
  assert.deepEqual(df.detect({ careers_url: URL_BASE }), { url: URL_BASE });
  assert.deepEqual(df.detect({ careers_url: 'https://jobs.dayforcehcm.com/ibgllc/CANDIDATEPORTAL' }), { url: 'https://jobs.dayforcehcm.com/ibgllc/CANDIDATEPORTAL' });
  for (const bad of ['http://jobs.dayforcehcm.com/en-US/ibgllc/CANDIDATEPORTAL', 'https://evil.example/en-US/ibgllc/CANDIDATEPORTAL', 'https://jobs.dayforcehcm.com.evil.example/en-US/a/b', 'https://jobs.dayforcehcm.com/en-US/ibgllc', 'nope', '']) {
    assert.equal(df.detect({ careers_url: bad }), null, bad);
  }
  assert.equal(df.detect({}), null);
  assert.equal(df.detect({ careers_url: 7 }), null);
  assert.equal(df.detect(null), null);
});

test('resolveConfig(): locale, namespace, site, country from entry or query', () => {
  assert.deepEqual(resolveConfig(ENTRY), CFG);
  assert.deepEqual(resolveConfig({ careers_url: 'https://jobs.dayforcehcm.com/acme/SITE' }), { ns: 'acme', site: 'SITE', locale: 'en-US', country: null });
  assert.equal(resolveConfig({ careers_url: `${URL_BASE}?country=us` }).country, 'US');
  assert.equal(resolveConfig({ careers_url: `${URL_BASE}?country=us`, country: 'CA' }).country, 'CA');
  assert.equal(resolveConfig({ careers_url: URL_BASE, country: 'USA' }).country, null);
});

test('parseSearchResponse(): real fixture rows', () => {
  const { rows, total, rawCount } = parseSearchResponse(FIXTURE, CFG);
  assert.equal(total, 3);
  assert.equal(rawCount, 3);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].title, 'Sr Engineer, IAM');
  assert.equal(rows[0].url, 'https://jobs.dayforcehcm.com/en-US/ibgllc/CANDIDATEPORTAL/jobs/2832');
  assert.equal(rows[0].location, 'Greenwich, CT, USA / Chicago, IL, USA / New York, NY, USA / Fort Lauderdale, FL, USA');
  assert.equal(rows[0].postedAt, Date.UTC(2026, 10, 6, 11, 0, 0));
});

test('parseSearchResponse(): country filter keeps postings with any matching location', () => {
  const { rows } = parseSearchResponse(FIXTURE, { ...CFG, country: 'US' });
  assert.deepEqual(rows.map((r) => r.title), ['Sr Engineer, IAM', 'Risk Assessment Analyst I']);
  const ch = parseSearchResponse(FIXTURE, { ...CFG, country: 'CH' }).rows;
  assert.equal(ch.length, 1);
  assert.equal(ch[0].location, 'Zug, Switzerland');
});

test('parseSearchResponse(): malformed records skipped, batch survives, entities decoded', () => {
  const { rows } = parseSearchResponse({
    maxCount: 6,
    jobPostings: [
      null,
      'x',
      { jobPostingId: 'abc', jobTitle: 'Bad id' },
      { jobPostingId: 5, jobTitle: { nested: true } },
      { jobPostingId: 6, jobTitle: 'R&amp;D Intern', postingLocations: 'not-an-array', postingStartTimestampUTC: 'garbage' },
      { jobPostingId: 7, jobTitle: 'Ok', postingLocations: [null, { cityName: 'Austin', stateCode: 'TX', isoCountryCode: 'US' }] },
    ],
  }, CFG);
  assert.deepEqual(rows.map((r) => r.title), ['R&D Intern', 'Ok']);
  assert.equal(rows[0].location, '');
  assert.equal(rows[0].postedAt, undefined);
  assert.equal(rows[1].location, 'Austin, TX, US');
});

test('parseSearchResponse(): error envelope / non-array container / non-object → descriptive throw', () => {
  assert.throws(() => parseSearchResponse({ type: 'https://httpstatuses.io/500', title: 'Internal Server Error', status: 500 }, CFG), /unexpected search response shape \(keys: type, title, status\) — Internal Server Error/);
  assert.throws(() => parseSearchResponse({ jobPostings: null, maxCount: 0 }, CFG), /unexpected search response shape/);
  assert.throws(() => parseSearchResponse({ jobPostings: { a: 1 } }, CFG), /unexpected search response shape/);
  assert.throws(() => parseSearchResponse({}, CFG), /keys: none/);
  assert.throws(() => parseSearchResponse(null, CFG), /unexpected search response/);
  assert.throws(() => parseSearchResponse([], CFG), /array/);
  assert.equal(parseSearchResponse({ jobPostings: [], maxCount: 0 }, CFG).rows.length, 0);
});

test('fetch(): CSRF bootstrap then POST with token + cookie, redirect:error everywhere', async () => {
  const ctx = makeCtx([FIXTURE]);
  const jobs = await df.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 3);
  assert.deepEqual(Object.keys(jobs[0]).sort(), ['company', 'location', 'postedAt', 'title', 'url']);
  assert.equal(jobs[0].company, 'Acme');
  assert.equal(ctx.boot.length, 1);
  assert.equal(ctx.boot[0].url, 'https://jobs.dayforcehcm.com/api/auth/csrf');
  assert.equal(ctx.boot[0].opts.redirect, 'error');
  assert.equal(ctx.calls.length, 1);
  const c = ctx.calls[0];
  assert.equal(c.url, 'https://jobs.dayforcehcm.com/api/geo/ibgllc/jobposting/search');
  assert.equal(c.opts.redirect, 'error');
  assert.equal(c.opts.method, 'POST');
  assert.equal(c.opts.headers['x-csrf-token'], 'a'.repeat(64));
  assert.equal(c.opts.headers.cookie, '__Host-next-auth.csrf-token=abc%7Cdef; __cf_bm=zzz');
  assert.deepEqual(JSON.parse(c.opts.body), { clientNamespace: 'ibgllc', jobBoardCode: 'CANDIDATEPORTAL', cultureCode: 'en-US', distanceUnit: 0, paginationStart: 0 });
});

test('fetch(): host/path guard throws before any request', async () => {
  for (const careers_url of ['https://evil.example/en-US/ibgllc/CANDIDATEPORTAL', 'http://jobs.dayforcehcm.com/en-US/ibgllc/CANDIDATEPORTAL', 'https://jobs.dayforcehcm.com/', 'nope']) {
    const ctx = makeCtx([FIXTURE]);
    await assert.rejects(() => df.fetch({ name: 'Acme', careers_url }, ctx));
    assert.equal(ctx.boot.length + ctx.calls.length, 0, careers_url);
  }
});

test('fetch(): CSRF bootstrap without token or cookie → throw, no search call', async () => {
  for (const r of [csrfResponse({ token: '' }), csrfResponse({ cookies: [] }), new Response('<html>', { status: 200 })]) {
    const ctx = makeCtx([FIXTURE], { fetchResponse: async () => r });
    await assert.rejects(() => df.fetch(ENTRY, ctx), /dayforce: CSRF bootstrap/);
    assert.equal(ctx.calls.length, 0);
  }
  await assert.rejects(() => df.fetch(ENTRY, makeCtx([FIXTURE], { fetchResponse: undefined })), /fetchResponse is required/);
});

test('fetch(): genuine zero → []; error envelope / non-2xx → throw', async () => {
  assert.deepEqual(await df.fetch(ENTRY, makeCtx([{ jobPostings: [], maxCount: 0, offset: 0, count: 0 }])), []);
  await assert.rejects(() => df.fetch(ENTRY, makeCtx([{ title: 'Forbidden', status: 403 }])), /unexpected search response shape/);
  await assert.rejects(() => df.fetch(ENTRY, makeCtx([{}])), /unexpected search response shape/);
  const e403 = Object.assign(new Error('HTTP 403 Forbidden'), { status: 403 });
  await assert.rejects(() => df.fetch(ENTRY, makeCtx([e403])), /HTTP 403/);
});

test('fetch(): paginates by paginationStart and stops at maxCount; country applied', async () => {
  const ctx = makeCtx([page(25, 1, 60), page(25, 26, 60, 'CA'), page(10, 51, 60)]);
  const jobs = await df.fetch({ ...ENTRY, country: 'US' }, ctx);
  assert.equal(jobs.length, 35);
  assert.deepEqual(ctx.calls.map((c) => JSON.parse(c.opts.body).paginationStart), [0, 25, 50]);
});

test('fetch(): DEFAULT_MAX_PAGES / max_pages ceiling stops an endless maxCount, and warns', async () => {
  const bodies = Array.from({ length: 300 }, (_, k) => page(25, k * 25 + 1, 1_000_000));
  const ctx = makeCtx(bodies);
  const orig = console.error;
  const msgs = [];
  console.error = (m) => msgs.push(String(m));
  try {
    const jobs = await df.fetch(ENTRY, ctx);
    assert.equal(ctx.calls.length, 40);
    assert.equal(jobs.length, 1000);
    const ctx2 = makeCtx(bodies);
    await df.fetch({ ...ENTRY, max_pages: 100000 }, ctx2);
    assert.equal(ctx2.calls.length, 200);
  } finally {
    console.error = orig;
  }
  assert.ok(msgs.some((m) => /raise max_pages/.test(m)));
});

test('fetch(): ctx.maxPages=1 → exactly one search request, no warning; rejection propagates unwrapped', async () => {
  const ctx = makeCtx([page(25, 1, 500), page(25, 26, 500)], { maxPages: 1 });
  const orig = console.error;
  const msgs = [];
  console.error = (m) => msgs.push(String(m));
  try {
    const jobs = await df.fetch(ENTRY, ctx);
    assert.equal(jobs.length, 25);
    assert.equal(ctx.calls.length, 1);
  } finally {
    console.error = orig;
  }
  assert.equal(msgs.length, 0);
  class ProbePageBudgetReached extends Error {}
  const sentinel = new ProbePageBudgetReached('budget');
  await assert.rejects(() => df.fetch(ENTRY, makeCtx([sentinel, sentinel, sentinel], { maxPages: 1 })), (e) => e === sentinel);
});

test('fetch(): page-2 failure after retries fails loud (no partial board, no max_pages warning)', async () => {
  const e500 = Object.assign(new Error('HTTP 500'), { status: 500 });
  const ctx = makeCtx([page(25, 1, 100), e500, e500, e500]);
  const orig = console.error;
  const msgs = [];
  console.error = (m) => msgs.push(String(m));
  try {
    await assert.rejects(() => df.fetch(ENTRY, ctx), /page 2 failed \(HTTP 500\) after 25 postings/);
  } finally {
    console.error = orig;
  }
  assert.ok(!msgs.some((m) => /raise max_pages/.test(m)));
});
