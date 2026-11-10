// tests/providers/apple.test.mjs — Apple Jobs search page (server-rendered
// React Router hydration data on jobs.apple.com/<locale>/search).
//
// The fixture is a trimmed live page (2026-11-08): three real rows (one PIPE
// pipeline role, two REQ rows), three malformed rows, totalRecords=6.
// No network — ctx is stubbed.
//
// Run:  node --test tests/providers/apple.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/apple.mjs')).href);
const ap = mod.default;
const { resolveConfig, buildPageUrl, extractSearchData, parseResults } = mod;

const FIXTURE = readFileSync(join(ROOT, 'tests/fixtures/apple-jobs-search.html'), 'utf8');
const ENTRY = { name: 'Apple', careers_url: 'https://jobs.apple.com/en-us/search?location=united-states-USA' };

function page(results, totalRecords) {
  const data = { loaderData: { root: {}, search: { searchResults: results, totalRecords, page: 1 } } };
  return `<script>window.__staticRouterHydrationData = JSON.parse(${JSON.stringify(JSON.stringify(data))});</script>`;
}
function row(n) {
  return { id: `2000${n}-0836`, positionId: `2000${n}`, type: 'REQ', postingTitle: `Engineer ${n}`, transformedPostingTitle: `engineer-${n}`,
    locations: [{ name: 'Cupertino', countryName: 'United States of America' }], postDateInGMT: '2026-11-01T00:00:00Z', team: { teamCode: 'SFTWR' } };
}
function makeCtx(pages) {
  const calls = [];
  let i = 0;
  return {
    calls,
    sleep: async () => {},
    fetchText: async (url, opts) => {
      calls.push({ url, opts });
      const b = typeof pages === 'function' ? pages(new URL(url)) : pages[i++];
      if (b instanceof Error) throw b;
      if (b === undefined) throw new Error(`unexpected request ${url}`);
      return b;
    },
    fetchJson: async () => { throw new Error('fetchJson must not be used'); },
  };
}

test('id and detect()', () => {
  assert.equal(ap.id, 'apple');
  assert.ok(ap.detect(ENTRY));
  assert.equal(ap.detect({ careers_url: 'https://www.apple.com/careers/us/' }), null);
  assert.equal(ap.detect({ careers_url: 'https://jobs.apple.com/en-us/details/123/x' }), null);
});

test('resolveConfig(): host/path/parameter allowlists enforced', () => {
  assert.deepEqual(resolveConfig(ENTRY), { locale: 'en-us', params: [['location', 'united-states-USA']] });
  assert.deepEqual(resolveConfig({ careers_url: 'https://jobs.apple.com/en-gb/search?team=internships-STDNT-INTRN&page=4' }).params,
    [['team', 'internships-STDNT-INTRN']]);
  for (const bad of [
    'http://jobs.apple.com/en-us/search',
    'https://jobs.apple.com.evil.example/en-us/search',
    'https://evil.example/en-us/search',
    'https://jobs.apple.com:444/en-us/search',
    'https://jobs.apple.com/en-us/../admin/search',
    'https://jobs.apple.com/en-us/search?callback=x',
    'https://jobs.apple.com/search',
  ]) {
    assert.throws(() => resolveConfig({ careers_url: bad }), Error, bad);
  }
});

test('buildPageUrl()', () => {
  const cfg = resolveConfig(ENTRY);
  assert.equal(buildPageUrl(cfg, 1), 'https://jobs.apple.com/en-us/search?location=united-states-USA');
  assert.equal(buildPageUrl(cfg, 2), 'https://jobs.apple.com/en-us/search?location=united-states-USA&page=2');
});

test('fixture: rows mapped to the rendered hrefs, malformed rows skipped', () => {
  const search = extractSearchData(FIXTURE);
  assert.equal(search.totalRecords, 6);
  const res = parseResults(search, 'en-us', 'Apple');
  assert.equal(res.rawCount, 6);
  assert.equal(res.skipped, 3);
  assert.deepEqual(res.jobs.map((j) => j.url), [
    'https://jobs.apple.com/en-us/details/114438158/us-specialist-seasonal-part-time?team=APPST',
    'https://jobs.apple.com/en-us/details/200687778-0836/wireless-software-engineer-wireless-technologies-ecosystems?team=SFTWR',
    'https://jobs.apple.com/en-us/details/200662678-0836/agent-development-engineer-customer-systems?team=SFTWR',
  ]);
  const [pipe, req] = res.jobs;
  assert.equal(pipe.title, 'US - Specialist: Seasonal, Part-time');
  assert.equal(pipe.location, 'United States');
  assert.equal(req.location, 'Cupertino, United States of America');
  assert.equal(req.postedAt, Date.parse('2026-11-08T19:33:56.388Z'));
  assert.equal(req.company, 'Apple');
});

test('unknown or broken shapes throw instead of returning []', () => {
  assert.throws(() => extractSearchData(''), /empty search page/);
  assert.throws(() => extractSearchData('<html>Access Denied</html>'), /no hydration data/);
  assert.throws(() => extractSearchData('__staticRouterHydrationData = JSON.parse("{not json");'), /not valid JSON/);
  assert.throws(() => extractSearchData(`__staticRouterHydrationData = JSON.parse(${JSON.stringify(JSON.stringify({ loaderData: { root: {} } }))});`), /no search loader/);
  assert.throws(() => extractSearchData(page({}, 3)), /searchResults is not an array/);
  assert.throws(() => extractSearchData(page([], '3')), /totalRecords is not a number/);
  assert.throws(() => parseResults({ searchResults: [{ id: 1 }, { postingTitle: 'x' }] }, 'en-us', 'Apple'), /none parsed/);
  assert.deepEqual(parseResults({ searchResults: [] }, 'en-us', 'Apple').jobs, []);
});

test('fetch(): paginates by raw count; one bad row does not stop it; host pinned; redirect refused', async () => {
  const p1 = page([...Array.from({ length: 19 }, (_, i) => row(100 + i)), { id: 'x' }], 45);
  const p2 = page(Array.from({ length: 20 }, (_, i) => row(200 + i)), 45);
  const p3 = page(Array.from({ length: 5 }, (_, i) => row(300 + i)), 45);
  const ctx = makeCtx([p1, p2, p3]);
  const jobs = await ap.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 44);
  assert.equal(ctx.calls.length, 3);
  for (const c of ctx.calls) {
    assert.equal(new URL(c.url).hostname, 'jobs.apple.com');
    assert.equal(c.opts.redirect, 'error');
  }
});

test('fetch(): short page mid-board keeps paging; shortfall reported as truncated', async () => {
  const ctx = makeCtx([
    page(Array.from({ length: 20 }, (_, i) => row(400 + i)), 60),
    page(Array.from({ length: 7 }, (_, i) => row(500 + i)), 60),
    page(Array.from({ length: 20 }, (_, i) => row(600 + i)), 60),
    page([], 60),
  ]);
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    assert.equal((await ap.fetch(ENTRY, ctx)).length, 47);
  } finally {
    console.error = orig;
  }
  assert.equal(ctx.calls.length, 4);
  assert.ok(errs.some((e) => /truncated/.test(e) && /47 of 60/.test(e)), errs.join('\n'));
});

test('fetch(): bounded by max_pages / ctx.maxPages; guard before any request', async () => {
  let n = 0;
  const ctx = makeCtx(() => page(Array.from({ length: 20 }, () => row(1000 + n++)), 99999));
  const orig = console.error;
  const errs = [];
  console.error = (...a) => errs.push(a.join(' '));
  try {
    await ap.fetch({ ...ENTRY, max_pages: 2 }, ctx);
    const probe = makeCtx(() => page([row(1)], 1));
    await ap.fetch(ENTRY, { ...probe, maxPages: 1 });
    assert.equal(probe.calls.length, 1);
  } finally {
    console.error = orig;
  }
  assert.equal(ctx.calls.length, 2);
  assert.ok(errs.some((e) => /max_pages=2/.test(e)));
  const none = makeCtx([]);
  await assert.rejects(ap.fetch({ name: 'x', careers_url: 'https://evil.example/en-us/search' }, none), /host not allowed/);
  assert.equal(none.calls.length, 0);
  const e = new Error('HTTP 403'); e.status = 403;
  await assert.rejects(ap.fetch(ENTRY, makeCtx([e])), /HTTP 403/);
});
