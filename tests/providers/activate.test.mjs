// tests/providers/activate.test.mjs — "Activate" hosted career sites
// (Ross Stores: jobs.rossstores.com, /Search/SearchResults jTable endpoint).
//
// The fixture is a trimmed live response (2026-11-07, 3 of 7,205 rows);
// no network is used — ctx is stubbed.
//
// Run:  node --test tests/providers/activate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/activate.mjs')).href);
const av = mod.default;
const { resolveConfig, buildSearchUrl, parseSearchResponse, toSlug } = mod;

const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/activate-search.json'), 'utf8'));
const URL_ROSS = 'https://jobs.rossstores.com/search/searchjobs';
const ORIGIN = 'https://jobs.rossstores.com';
const ENTRY = { name: 'Ross Stores', provider: 'activate', careers_url: URL_ROSS };

const gid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function page(n, start, total) {
  return {
    Result: 'OK',
    TotalRecordCount: total,
    Records: Array.from({ length: n }, (_, i) => ({
      ID: gid(start + i),
      Title: `<span>Job ${start + i}</span>`,
      CityStateDataAbbrev: '<span>Dublin, CA</span>',
      CountryName: '<span>United States</span>',
      PostedDateRaw: '2026-11-01T00:00:00',
      TrackingObject: { TitleJson: `Job ${start + i}` },
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
      return b === undefined ? { Result: 'OK', Records: [], TotalRecordCount: 0 } : b;
    },
    ...extra,
  };
}

test('id; no URL-pattern detect (branded domains)', () => {
  assert.equal(av.id, 'activate');
  assert.equal(av.detect, undefined);
});

test('resolveConfig(): https only, rejects IP/localhost/credentials/ports, keeps search query minus jt*', () => {
  const cfg = resolveConfig({ careers_url: 'https://jobs.rossstores.com/search/searchjobs?Keyword=buyer&jtStartIndex=40&CountryOnly=US' });
  assert.equal(cfg.origin, ORIGIN);
  assert.equal(cfg.query.toString(), 'Keyword=buyer&CountryOnly=US');
  for (const bad of ['http://jobs.rossstores.com/', 'https://127.0.0.1/', 'https://localhost/', 'https://[::1]/', 'https://u:p@jobs.rossstores.com/', 'https://jobs.rossstores.com:8443/', 'https://intranet/', 'nope', '']) {
    assert.throws(() => resolveConfig({ careers_url: bad }), undefined, bad);
  }
  assert.throws(() => resolveConfig({}), /careers_url is required/);
});

test('buildSearchUrl(): same origin, page params appended', () => {
  const u = new URL(buildSearchUrl(resolveConfig({ careers_url: `${URL_ROSS}?Keyword=intern` }), 1000, 500));
  assert.equal(u.origin, ORIGIN);
  assert.equal(u.pathname, '/Search/SearchResults');
  assert.equal(u.searchParams.get('Keyword'), 'intern');
  assert.equal(u.searchParams.get('jtStartIndex'), '1000');
  assert.equal(u.searchParams.get('jtPageSize'), '500');
});

test('toSlug() mirrors core.common.convertToSlug', () => {
  assert.equal(toSlug('Summer 2027 Intern - Buying, Planning, or Rotational - New York'), 'summer-2027-intern---buying-planning-or-rotational---new-york');
  assert.equal(toSlug('IT Manager II (Enterprise Data Integration)'), 'it-manager-ii-enterprise-data-integration');
});

test('parseSearchResponse(): real fixture', () => {
  const { rows, rawCount, total } = parseSearchResponse(FIXTURE, ORIGIN);
  assert.equal(rawCount, 3);
  assert.equal(total, 7205);
  assert.equal(rows.length, 3);
  const r = rows[0];
  assert.equal(r.title, 'Store Manager');
  assert.equal(r.url, `${ORIGIN}/search/jobdetails/store-manager/39b4d358-cf63-4975-b392-54adaf0b1b48`);
  assert.equal(r.location, 'Oklahoma City, OK, United States');
  assert.equal(r.postedAt, Date.UTC(2026, 10, 7));
});

test('parseSearchResponse(): error envelope / bad shapes throw, empty Records is empty', () => {
  assert.throws(() => parseSearchResponse({ Result: 'ERROR', Message: 'An error occured while processing your request.' }, ORIGIN), /Result=ERROR: An error occured/);
  assert.throws(() => parseSearchResponse({ Result: 'OK', Records: { a: 1 } }, ORIGIN), /Records is not an array/);
  assert.throws(() => parseSearchResponse({ Result: 'OK' }, ORIGIN), /Records is not an array/);
  assert.throws(() => parseSearchResponse({ jobs: [] }, ORIGIN), /unexpected SearchResults shape \(keys: jobs\)/);
  assert.throws(() => parseSearchResponse([], ORIGIN), /unexpected SearchResults body/);
  assert.throws(() => parseSearchResponse(null, ORIGIN), /unexpected SearchResults body/);
  assert.deepEqual(parseSearchResponse({ Result: 'OK', Records: [], TotalRecordCount: 0 }, ORIGIN).rows, []);
  assert.throws(() => parseSearchResponse('<html>blocked</html>', ORIGIN), /unexpected SearchResults body \(string\)/);
  assert.throws(() => parseSearchResponse('{not json', ORIGIN), /string that is not JSON/);
});

test('parseSearchResponse(): double-encoded body (Accept: application/json) is unwrapped once', () => {
  const { rows, total } = parseSearchResponse(JSON.stringify(FIXTURE), ORIGIN);
  assert.equal(rows.length, 3);
  assert.equal(total, 7205);
});

test('parseSearchResponse(): one malformed record is skipped, not fatal', () => {
  const good = FIXTURE.Records[0];
  const body = {
    Result: 'OK',
    TotalRecordCount: 6,
    Records: [null, 7, { ID: 42, Title: 'x' }, { ID: '../../etc', Title: 'x' }, { ID: gid(1), Title: { html: 1 }, TrackingObject: { TitleJson: 5 } }, good],
  };
  const { rows, rawCount } = parseSearchResponse(body, ORIGIN);
  assert.equal(rawCount, 6);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Store Manager');
});

test('fetch(): 1-row probe for the total, then the whole list in one request (paging is unstable)', async () => {
  const ctx = makeCtx([page(1, 0, 1100), page(1100, 0, 1100)]);
  const jobs = await av.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 1100);
  assert.equal(ctx.calls.length, 2);
  const [probe, full] = ctx.calls.map((c) => new URL(c.url));
  assert.equal(probe.searchParams.get('jtPageSize'), '1');
  assert.equal(full.searchParams.get('jtPageSize'), '1150');
  assert.equal(full.searchParams.get('jtStartIndex'), '0');
  for (const c of ctx.calls) {
    assert.equal(new URL(c.url).origin, ORIGIN);
    assert.equal(c.opts.redirect, 'error');
    assert.equal(c.opts.headers.accept, undefined);
  }
  assert.equal(jobs[0].company, 'Ross Stores');
  assert.equal(jobs[0].location, 'Dublin, CA, United States');
  assert.equal(jobs[0].postedAt, Date.UTC(2026, 10, 1));
});

test('fetch(): duplicate IDs in the response are collapsed', async () => {
  const p = page(3, 0, 3);
  p.Records.push({ ...p.Records[0] });
  const jobs = await av.fetch(ENTRY, makeCtx([page(1, 0, 4), p]));
  assert.equal(jobs.length, 3);
});

test('fetch(): host guard runs before any request', async () => {
  const ctx = makeCtx([page(1, 0, 1)]);
  await assert.rejects(av.fetch({ name: 'x', careers_url: 'http://jobs.rossstores.com/' }, ctx), /non-https/);
  await assert.rejects(av.fetch({ name: 'x', careers_url: 'https://169.254.169.254/' }, ctx), /host not allowed/);
  assert.equal(ctx.calls.length, 0);
});

test('fetch(): error envelope throws (never a silent empty) — on the probe and on the full call', async () => {
  await assert.rejects(av.fetch(ENTRY, makeCtx([{ Result: 'ERROR', Message: 'boom' }])), /Result=ERROR: boom/);
  await assert.rejects(av.fetch(ENTRY, makeCtx([page(1, 0, 10), { Result: 'ERROR', Message: 'late' }])), /Result=ERROR: late/);
});

test('fetch(): total>0 but the full call returns no rows → throw', async () => {
  await assert.rejects(av.fetch(ENTRY, makeCtx([page(1, 0, 10), { Result: 'OK', Records: [], TotalRecordCount: 10 }])), /reported 10 postings but returned none/);
});

test('fetch(): missing TotalRecordCount with rows → throw', async () => {
  const p = page(1, 0, 1);
  delete p.TotalRecordCount;
  await assert.rejects(av.fetch(ENTRY, makeCtx([p])), /no TotalRecordCount/);
});

test('fetch(): genuine zero-result board returns [] after one request', async () => {
  const ctx = makeCtx([{ Result: 'OK', Records: [], TotalRecordCount: 0 }]);
  assert.deepEqual(await av.fetch(ENTRY, ctx), []);
  assert.equal(ctx.calls.length, 1);
});

test('fetch(): transport error propagates', async () => {
  await assert.rejects(av.fetch(ENTRY, makeCtx([Object.assign(new Error('HTTP 403'), { status: 403 })])), /HTTP 403/);
  await assert.rejects(av.fetch(ENTRY, makeCtx([page(1, 0, 5), Object.assign(new Error('HTTP 400'), { status: 400 })])), /HTTP 400/);
});

test('fetch(): row ceiling — server total never sizes the request past max_jobs / the hard cap', async () => {
  const errs = [];
  const orig = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    const ctx = makeCtx([page(1, 0, 10_000_000), page(10, 0, 10_000_000)]);
    await av.fetch(ENTRY, ctx);
    assert.equal(new URL(ctx.calls[1].url).searchParams.get('jtPageSize'), '10000');
    const ctx2 = makeCtx([page(1, 0, 10_000_000), page(10, 0, 10_000_000)]);
    await av.fetch({ ...ENTRY, max_jobs: 999_999 }, ctx2);
    assert.equal(new URL(ctx2.calls[1].url).searchParams.get('jtPageSize'), '25000');
    const ctx3 = makeCtx([page(1, 0, 50), page(50, 0, 50)]);
    const jobs = await av.fetch({ ...ENTRY, max_jobs: 20 }, ctx3);
    assert.equal(jobs.length, 20);
  } finally {
    console.error = orig;
  }
  assert.ok(errs.some((e) => /truncated/.test(e)));
});

test('fetch(): health probe (ctx.maxPages) makes one small request', async () => {
  const ctx = makeCtx([page(100, 0, 5000)], { maxPages: 1 });
  const jobs = await av.fetch(ENTRY, ctx);
  assert.equal(ctx.calls.length, 1);
  assert.equal(new URL(ctx.calls[0].url).searchParams.get('jtPageSize'), '100');
  assert.equal(jobs.length, 100);
});

// Regression (Codex review 2026-11-07)
import { resolveConfig as resolveActivateCfg } from '../../providers/activate.mjs';
test('regression: host outside the allowlist is rejected before any request', () => {
  assert.throws(() => resolveActivateCfg({ careers_url: 'https://unrelated.example/search' }), /allowlist/);
});
