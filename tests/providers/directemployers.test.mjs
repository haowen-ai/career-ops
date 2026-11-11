// tests/providers/directemployers.test.mjs — DirectEmployers/NLx microsite
// search API (prod-search-api.jobsyn.org, X-Origin = careers host).
//
// Row fixtures are trimmed live rows (2026-11-11, careers.alaskaair.com page 1:
// 9 jobs + 3 featured, total 70; only the fields the provider reads are kept,
// descriptions shortened). No network is used — ctx is stubbed.
//
// Run:  node --test tests/providers/directemployers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/directemployers.mjs')).href);
const de = mod.default;
const { resolveConfig, buildSearchUrl, buildJobUrl, parseSearch, slugify } = mod;

const ENTRY = { name: 'Acme', careers_url: 'https://careers.alaskaair.com/jobs/' };
const CFG = resolveConfig(ENTRY);

// Trimmed real rows.
const LOUNGE = {
  guid: 'E1744B8C99154C7CB30C7B70F426F66E', reqid: '2026-23463', title_exact: 'Senior Manager Lounge',
  title_slug: 'senior-manager-lounge', location_exact: 'Seatac, WA', country_short_exact: 'USA',
  date_new: '2026-11-11T04:00:05Z', date_added: '2026-11-11T04:02:31.149Z', company_exact: 'Alaska Airlines',
  description: '**Company** Alaska Airlines\n  \n**The Team**\n  \nGuided by our purpose…',
};
const FUEL = {
  guid: '81BC0EAF8F1D4B71984A93C8058D6F6D', reqid: '2026-23529', title_exact: 'Senior Manager Fuel Sourcing & Trading',
  title_slug: 'senior-manager-fuel-sourcing-trading', location_exact: 'Seatac, WA', country_short_exact: 'USA',
  date_new: '2026-11-11T01:00:07Z', company_exact: 'Alaska Airlines',
};
const PSA = {
  guid: '2663BBFD98394365958968E0765CFAC0', reqid: '2026-23362', title_exact: 'Passenger Service Agent',
  title_slug: 'passenger-service-agent', location_exact: 'Spokane, WA', country_short_exact: 'USA',
  date_new: '2026-11-09T20:01:04Z', company_exact: 'Horizon Air',
};
// Featured row that appears on no jobs page (how jobs ∪ featured reached 70).
const GSE = {
  guid: 'CE8F77DABB694D67A837983D80B4C5D8', reqid: '2026-22751',
  title_exact: 'Ground Support Equipment Mechanic - $3,500 Sign-On Bonus',
  title_slug: 'ground-support-equipment-mechanic-3500-sign-on-bonus', location_exact: 'Honolulu, HI',
  country_short_exact: 'USA', date_new: '2026-11-03T04:01:51Z', company_exact: 'Hawaiian Airlines',
};

function pagination(page, total, hasMore) {
  return { has_more_pages: hasMore, offset: (page - 1) * 10, page, page_size: 10, total, total_pages: total === null ? null : Math.ceil(total / 10) };
}
function body(jobs, page, total, featured = [], hasMore = page * 10 < total) {
  return { featured_jobs: featured, filters: {}, jobs, meta: { source: 'solr' }, pagination: pagination(page, total, hasMore) };
}
let n = 0;
function synth() {
  n++;
  const hex = n.toString(16).toUpperCase().padStart(32, '0');
  return { guid: hex, title_exact: `Job ${n}`, title_slug: `job-${n}`, location_exact: 'Anchorage, AK', reqid: `R-${n}` };
}
const synthPage = (k) => Array.from({ length: k }, synth);

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
      return b === undefined ? body([], 99, 0) : b;
    },
    fetchText: async () => { throw new Error('fetchText must not be used'); },
    ...extra,
  };
}

function silence(fn) {
  return async () => {
    const orig = console.error;
    const lines = [];
    console.error = (...a) => lines.push(a.join(' '));
    try { await fn(lines); } finally { console.error = orig; }
  };
}

test('id; detect() never claims an entry (explicit provider only)', () => {
  assert.equal(de.id, 'directemployers');
  assert.equal(de.detect(ENTRY), null);
  assert.equal(de.detect({ provider: 'directemployers' }), null);
});

test('resolveConfig(): allowlisted https host only; API URL is a fixed literal', () => {
  assert.deepEqual(CFG, { origin: 'https://careers.alaskaair.com', host: 'careers.alaskaair.com' });
  assert.equal(buildSearchUrl(3), 'https://prod-search-api.jobsyn.org/api/v1/solr/search?page=3');
  for (const bad of [
    'http://careers.alaskaair.com/', 'https://evil.example.com/', 'https://careers.alaskaair.com.evil.com/',
    'https://a:b@careers.alaskaair.com/', 'https://careers.alaskaair.com:8443/', 'nope', '', undefined, 42,
  ]) {
    assert.throws(() => resolveConfig({ careers_url: bad }), undefined, String(bad));
  }
});

test('fetch(): allowlist guard throws before any request', async () => {
  const ctx = makeCtx([body([LOUNGE], 1, 1)]);
  await assert.rejects(() => de.fetch({ name: 'Acme', careers_url: 'https://example.com/jobs' }, ctx), /allowlist/);
  await assert.rejects(() => de.fetch({ name: 'Acme', careers_url: 'http://careers.alaskaair.com/' }, ctx), /non-https/);
  assert.equal(ctx.calls.length, 0);
});

test('slugify() / buildJobUrl(): same path the site router builds', () => {
  assert.equal(slugify('Seatac, WA'), 'seatac-wa');
  assert.equal(slugify('Tokyo, JPN'), 'tokyo-jpn');
  assert.equal(slugify('São Paulo, SP'), 'sao-paulo-sp');
  assert.equal(slugify("Kailua-Kona/Hilo: O’ahu"), 'kailua-konahilo-oahu');
  assert.equal(slugify(null), '');
  assert.equal(buildJobUrl(LOUNGE, CFG),
    'https://careers.alaskaair.com/seatac-wa/senior-manager-lounge/E1744B8C99154C7CB30C7B70F426F66E/job/');
  // bad title_slug → slug from the title; missing location → country slug
  assert.equal(buildJobUrl({ ...FUEL, title_slug: '../x', location_exact: '' }, CFG),
    'https://careers.alaskaair.com/usa/senior-manager-fuel-sourcing-trading/81BC0EAF8F1D4B71984A93C8058D6F6D/job/');
  assert.equal(buildJobUrl({ ...LOUNGE, guid: '../../admin' }, CFG), null);
  assert.equal(buildJobUrl({ ...LOUNGE, guid: undefined }, CFG), null);
  assert.equal(buildJobUrl({ ...LOUNGE, location_exact: '', country_short_exact: '' }, CFG), null);
});

test('parseSearch(): real rows normalized, featured merged, duplicates and bad rows dropped', () => {
  const { rows, total, hasMore, rawCount } = parseSearch(
    body([LOUNGE, FUEL, PSA, { ...LOUNGE }, { guid: 'X' }, null, { ...PSA, guid: 'F'.repeat(32), title_exact: '  ' }], 1, 70, [GSE, FUEL]),
    CFG,
  );
  assert.equal(total, 70);
  assert.equal(hasMore, true);
  assert.equal(rawCount, 7);
  assert.deepEqual(rows.map((r) => r.title), [
    'Senior Manager Lounge', 'Senior Manager Fuel Sourcing & Trading', 'Passenger Service Agent',
    'Ground Support Equipment Mechanic - $3,500 Sign-On Bonus',
  ]);
  const r0 = rows[0];
  assert.equal(r0.url, 'https://careers.alaskaair.com/seatac-wa/senior-manager-lounge/E1744B8C99154C7CB30C7B70F426F66E/job/');
  assert.equal(r0.location, 'Seatac, WA');
  assert.equal(r0.requisitionId, '2026-23463');
  assert.equal(r0.postedAt, Date.parse('2026-11-11T04:00:05Z'));
  assert.match(r0.description, /Alaska Airlines/);
  assert.equal(rows[3].url,
    'https://careers.alaskaair.com/honolulu-hi/ground-support-equipment-mechanic-3500-sign-on-bonus/CE8F77DABB694D67A837983D80B4C5D8/job/');
  // NaN-safe date: bad date_new falls back to date_added, then absent
  const [d] = parseSearch(body([{ ...LOUNGE, date_new: 'not a date' }], 1, 1), CFG).rows;
  assert.equal(d.postedAt, Date.parse('2026-11-11T04:02:31.149Z'));
  const [e] = parseSearch(body([{ ...FUEL, date_new: 'nope' }], 1, 1), CFG).rows;
  assert.equal('postedAt' in e, false);
});

test('parseSearch(): empty bodies → no rows; wrong shape → descriptive throw', () => {
  for (const empty of [null, undefined, {}, body([], 1, 0)]) {
    assert.equal(parseSearch(empty, CFG).rows.length, 0);
  }
  assert.throws(() => parseSearch({ results: [], count: 3 }, CFG), /no jobs array; keys: results, count/);
  assert.throws(() => parseSearch({ jobs: { a: 1 } }, CFG), /no jobs array/);
  assert.throws(() => parseSearch([LOUNGE], CFG), /array/);
  assert.throws(() => parseSearch('<html>', CFG), /string/);
  assert.throws(() => parseSearch(body([{ title: 'x' }], 1, 70), CFG), /reports 70 jobs but no job rows/);
});

test('fetch(): pages until total, X-Origin + redirect:error on every request, job shape', async () => {
  const p1 = synthPage(9);
  const p2 = synthPage(10);
  const p3 = synthPage(3);
  // 9 jobs + featured GSE on page 1, featured repeated on page 2 → dedup; 23 total
  const ctx = makeCtx([body([...p1], 1, 23, [GSE]), body([...p2], 2, 23, [GSE]), body([...p3], 3, 23, [], false)]);
  const jobs = await de.fetch(ENTRY, ctx);
  assert.equal(ctx.calls.length, 3);
  assert.deepEqual(ctx.calls.map((c) => new URL(c.url).searchParams.get('page')), ['1', '2', '3']);
  for (const c of ctx.calls) {
    assert.equal(new URL(c.url).origin, 'https://prod-search-api.jobsyn.org');
    assert.equal(c.opts.redirect, 'error');
    assert.equal(c.opts.headers['x-origin'], 'careers.alaskaair.com');
  }
  assert.equal(jobs.length, 23);
  assert.equal(new Set(jobs.map((j) => j.url)).size, 23);
  assert.equal(jobs.truncated, undefined);
  const g = jobs.find((j) => j.title.startsWith('Ground Support'));
  assert.equal(g.company, 'Acme');
  assert.equal(g.location, 'Honolulu, HI');
  assert.equal(g.requisitionId, '2026-22751');
});

test('fetch(): stops on has_more_pages=false / empty page / no fresh rows', async () => {
  const a = makeCtx([body(synthPage(10), 1, 500, [], false)]);
  assert.equal((await de.fetch(ENTRY, a)).length, 10);
  assert.equal(a.calls.length, 1);
  const p = synthPage(10);
  // no usable total (null): stop on a page that brings nothing new
  const b = makeCtx([body(p, 1, null, [], true), body(p, 2, null, [], true)]);
  assert.equal((await de.fetch(ENTRY, b)).length, 10);
  assert.equal(b.calls.length, 2);
  const c = makeCtx([body(synthPage(10), 1, null, [], true), body([], 2, null, [], true)]);
  const stalled = await de.fetch(ENTRY, c);
  assert.equal(stalled.length, 10);
  assert.equal(c.calls.length, 2);
  // has_more_pages was still true when the empty page stopped the walk: incomplete
  assert.equal(stalled.truncated, true);
});

test('fetch(): fewer unique rows than total (no cap) → truncated', silence(async (lines) => {
  const p = synthPage(10);
  const ctx = makeCtx([body(p, 1, 25), body(p, 2, 25)]); // page 2 repeats page 1
  const jobs = await de.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 10);
  assert.equal(jobs.truncated, true);
  assert.ok(lines.some((l) => /site reports 25/.test(l)));
}));

test('fetch(): max_pages / max_jobs caps set truncated and warn; DEFAULT_MAX_PAGES bounds a lying total', silence(async (lines) => {
  const ctx = makeCtx([body(synthPage(10), 1, 100), body(synthPage(10), 2, 100), body(synthPage(10), 3, 100)]);
  const jobs = await de.fetch({ ...ENTRY, max_pages: 2 }, ctx);
  assert.equal(ctx.calls.length, 2);
  assert.equal(jobs.length, 20);
  assert.equal(jobs.truncated, true);
  assert.ok(lines.some((l) => /truncated at 20 of 100 .*raise max_pages/.test(l)));

  const ctx2 = makeCtx([body(synthPage(10), 1, 100), body(synthPage(10), 2, 100)]);
  const jobs2 = await de.fetch({ ...ENTRY, max_jobs: 15 }, ctx2);
  assert.equal(jobs2.length, 15);
  assert.equal(jobs2.truncated, true);

  const huge = Array.from({ length: 40 }, (_, i) => body(synthPage(10), i + 1, 1_000_000));
  const ctx3 = makeCtx(huge);
  const jobs3 = await de.fetch(ENTRY, ctx3);
  assert.equal(ctx3.calls.length, 30);
  assert.equal(jobs3.length, 300);
  assert.equal(jobs3.truncated, true);
}));

test('fetch(): page-2 failure keeps page 1, marks truncated, no "raise max_pages"; page-1 failure throws', silence(async (lines) => {
  const err = Object.assign(new Error('HTTP 404'), { status: 404 });
  const jobs = await de.fetch(ENTRY, makeCtx([body(synthPage(10), 1, 30), err]));
  assert.equal(jobs.length, 10);
  assert.equal(jobs.truncated, true);
  assert.ok(lines.some((l) => /page 2 failed/.test(l)));
  assert.ok(!lines.some((l) => /raise max_pages/.test(l)));
  await assert.rejects(() => de.fetch(ENTRY, makeCtx([err])), (e) => e === err);
}));

test('fetch(): ctx.maxPages=1 → one request; probe rejection propagates unwrapped', async () => {
  const ctx = makeCtx([body(synthPage(10), 1, 70), body(synthPage(10), 2, 70)], { maxPages: 1 });
  const jobs = await de.fetch(ENTRY, ctx);
  assert.equal(ctx.calls.length, 1);
  assert.equal(jobs.length, 10);
  class ProbePageBudgetReached extends Error {}
  const err = new ProbePageBudgetReached('budget');
  await assert.rejects(() => de.fetch(ENTRY, makeCtx([body(synthPage(10), 1, 70), err, err, err], { maxPages: 2 })), (e) => e === err);
});

test('fetch(): malformed response throws; empty board → []', async () => {
  await assert.rejects(() => de.fetch(ENTRY, makeCtx([{ error: 'bad origin' }])), /no jobs array; keys: error/);
  const empty = await de.fetch(ENTRY, makeCtx([body([], 1, 0, [], false)]));
  assert.deepEqual([...empty], []);
  assert.equal(empty.truncated, undefined);
  assert.deepEqual([...(await de.fetch(ENTRY, makeCtx([{}])))], []);
});
