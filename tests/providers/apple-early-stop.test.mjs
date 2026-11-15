// Apple whole-board early stop (career-journal plan 2026-11-14 v5 + r2 + r3).
//
// Only the verified board (/en-us/search?location=united-states-USA) may stop early, and only when the caller passes
// ctx.isKnownListing and ctx.earlyStopBeforeMs. The request then asks for sort=newest (live evidence 2026-11-15: the
// same 4,566 ids in the same order as the default, postDateInGMT never rising over all 229 pages), and a page whose
// server echo is not "newest" is never used for the stop. Every walk reports jobs.collection.status:
//   early_stopped | complete (every page reported the first page's total, and the distinct raw ids reached it)
//   | page_failed (empty or repeated page short of the total) | ceiling (max_pages) | unverified (the total changed
//   during the walk, or a row had no id).
// No network — ctx is stubbed.
//
// Run:  node --test tests/providers/apple-early-stop.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const ap = (await import(pathToFileURL(join(ROOT, 'providers/apple.mjs')).href)).default;

const ENTRY = { name: 'Apple', careers_url: 'https://jobs.apple.com/en-us/search?location=united-states-USA' };
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-15T17:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const BOUND = NOW - 4 * DAY;

function html(rows, totalRecords, sort = 'newest') {
  const data = { loaderData: { root: {}, search: { searchResults: rows, totalRecords, sort, page: 1 } } };
  return `<script>window.__staticRouterHydrationData = JSON.parse(${JSON.stringify(JSON.stringify(data))});</script>`;
}
// One row: [id, ms, type?]. Without ms the row has no date.
function row([id, ms, type = 'REQ']) {
  return { id, positionId: String(id).replace(/^PIPE-/, ''), type, postingTitle: `Role ${id}`, transformedPostingTitle: `role-${String(id).toLowerCase()}`,
    locations: [{ name: 'Cupertino', countryName: 'United States of America', level: 5 }], team: { teamCode: 'SFTWR' },
    ...(ms == null ? {} : { postDateInGMT: typeof ms === 'string' ? ms : iso(ms) }) };
}
// n rows of one page, ids `${prefix}${i}`, dated from `startMs` going back one hour per row.
const block = (prefix, n, startMs) => Array.from({ length: n }, (_, i) => [`${prefix}${i}`, startMs - i * 3_600_000]);

function ctxOf(pages, { known = null, bound = BOUND, extra = {} } = {}) {
  const calls = [];
  let i = 0;
  const ctx = {
    calls,
    sleep: async () => {},
    fetchText: async (url) => {
      calls.push(url);
      const b = typeof pages === 'function' ? pages(new URL(url), i++) : pages[i++];
      if (b instanceof Error) throw b;
      if (b === undefined) throw new Error(`unexpected request ${url}`);
      return b;
    },
    fetchJson: async () => { throw new Error('fetchJson must not be used'); },
    ...extra,
  };
  if (known) ctx.isKnownListing = (job) => known.has(job.id);
  if (known && bound != null) ctx.earlyStopBeforeMs = bound;
  return ctx;
}
const quiet = async (fn) => {
  const orig = console.error;
  const errs = [];
  console.error = (...a) => errs.push(a.join(' '));
  try { return { value: await fn(), errs }; } finally { console.error = orig; }
};
const statusOf = (jobs) => jobs.collection?.status;

// A date-ordered board of `pages` full pages (20 rows) plus `tail` rows, newest first, one hour apart.
function board(pages, tail = 0, { startMs = NOW - 3_600_000 } = {}) {
  const out = [];
  let t = startMs;
  for (let p = 0; p < pages + (tail ? 1 : 0); p++) {
    const n = p < pages ? 20 : tail;
    out.push(Array.from({ length: n }, (_, i) => [`R${p}-${i}`, t - i * 3_600_000]));
    t -= n * 3_600_000;
  }
  return out;
}
const allIds = (pages) => new Set(pages.flat().map(([id]) => id));

test('sorted board: stops at the first fully known page whose last row is before the bound; asks sort=newest', async () => {
  const pages = board(10); // rows one hour apart: page p covers hours 20p+1 .. 20p+20 before NOW
  pages[0][0] = ['PIPE-114438158', NOW + 60_000, 'PIPE']; // live: this row is dated at request time; it stays first
  const known = allIds(pages);
  known.delete('R0-5'); // a new posting on page 1
  const total = 200;
  const ctx = ctxOf(pages.map((rows) => html(rows.map(row), total)), { known });
  const jobs = await ap.fetch(ENTRY, ctx);
  // Bound = 96 h ago. Page 5 (index 4) spans hours 81..100, its last row is 100 h old → stop there.
  assert.equal(ctx.calls.length, 5);
  assert.equal(statusOf(jobs), 'early_stopped');
  assert.equal(jobs.truncated, undefined, 'an early stop is not a truncated read');
  assert.ok(jobs.some((j) => j.id === 'R0-5'), 'the new posting is delivered');
  for (const url of ctx.calls) assert.equal(new URL(url).searchParams.get('sort'), 'newest', url);
  assert.equal(new URL(ctx.calls[1]).searchParams.get('page'), '2');
  assert.equal(new URL(ctx.calls[0]).searchParams.get('location'), 'united-states-USA');
});

test('real page order (live probe 2026-11-15, pages 1-16): stops where the bound falls, delivers every unknown id read', async () => {
  const fx = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/apple-board-order-2026-11-15.json'), 'utf8'));
  const readAt = Date.parse(fx.readAt);
  const bound = readAt - 96 * 3_600_000; // last night's start − 72 h
  const known = new Set(fx.pages.flat().map(([id]) => id));
  const fresh = fx.pages[2][7][0];
  known.delete(fresh);
  const ctx = ctxOf(fx.pages.map((rows) => html(rows.map(row), fx.totalRecords)), { known, bound });
  const jobs = await ap.fetch(ENTRY, ctx);
  const stopAt = fx.pages.findIndex((rows) => Date.parse(rows[rows.length - 1][1]) < bound) + 1;
  assert.equal(ctx.calls.length, stopAt);
  assert.ok(stopAt > 3 && stopAt < 16, `stopped at page ${stopAt}`);
  assert.equal(statusOf(jobs), 'early_stopped');
  assert.ok(jobs.some((j) => j.id === fresh));
  // every row on the pages read is delivered
  assert.equal(jobs.length, new Set(fx.pages.slice(0, stopAt).flat().map(([id]) => id)).size);
});

test('a server that does not echo sort=newest is never stopped; the full read is complete', async () => {
  const pages = board(6);
  const ctx = ctxOf(pages.map((rows) => html(rows.map(row), 120, '')), { known: allIds(pages) });
  const jobs = await ap.fetch(ENTRY, ctx);
  assert.equal(ctx.calls.length, 6);
  assert.equal(statusOf(jobs), 'complete');
});

test('a date that goes up (a second segment, a pinned block) turns the stop off for the walk', async () => {
  const pages = board(8);
  // page 3 starts a second newest-first segment
  pages[2] = block('S', 20, NOW - 3_600_000);
  const ctx = ctxOf(pages.map((rows) => html(rows.map(row), 160)), { known: allIds(pages) });
  const jobs = await ap.fetch(ENTRY, ctx);
  assert.equal(ctx.calls.length, 8, 'read to the end');
  assert.equal(statusOf(jobs), 'complete');
});

test('a last row without a date never stops; the next fully known page does', async () => {
  const pages = board(10);
  pages[4][19] = [pages[4][19][0], null];
  const ctx = ctxOf(pages.map((rows) => html(rows.map(row), 200)), { known: allIds(pages) });
  const jobs = await ap.fetch(ENTRY, ctx);
  assert.equal(ctx.calls.length, 6);
  assert.equal(statusOf(jobs), 'early_stopped');
});

test('a page with an unseen id past the bound keeps reading', async () => {
  const pages = board(10);
  const known = allIds(pages);
  known.delete('R4-10');
  const ctx = ctxOf(pages.map((rows) => html(rows.map(row), 200)), { known });
  const jobs = await ap.fetch(ENTRY, ctx);
  assert.equal(ctx.calls.length, 6);
  assert.ok(jobs.some((j) => j.id === 'R4-10'));
  assert.equal(statusOf(jobs), 'early_stopped');
});

test('a total that falls during the walk: never stops, reads to the end, unverified (Codex plan review r2)', async () => {
  // Page 1: 20 rows of 60; then 10 rows are taken down, the board serves offset 20 of 50.
  const rows = board(3).flat();
  const known = new Set(rows.map(([id]) => id));
  known.delete('R0-3'); // a new posting on page 1, so page 1 itself cannot stop
  known.delete('R1-4'); // would be skipped by the shift
  const pages = [html(rows.slice(0, 20).map(row), 60), html(rows.slice(30, 50).map(row), 50), html(rows.slice(50, 60).map(row), 50), html([], 0)];
  const ctx = ctxOf(pages, { known, bound: NOW + DAY });
  const { value: jobs } = await quiet(() => ap.fetch(ENTRY, ctx));
  assert.equal(ctx.calls.length, 4, 'no early stop once the total changed');
  assert.equal(statusOf(jobs), 'unverified');
});

test('a total that rises during the walk reads on to the empty page and is unverified', async () => {
  const rows = board(3).flat();
  const pages = [html(rows.slice(0, 20).map(row), 59), html(rows.slice(20, 40).map(row), 60), html(rows.slice(40, 60).map(row), 60), html([], 0)];
  const { value: jobs } = await quiet(() => ap.fetch(ENTRY, ctxOf(pages)));
  assert.equal(jobs.length, 60);
  assert.equal(statusOf(jobs), 'unverified');
});

test('the last page ends a full read: complete, and the request is the same as without early stop', async () => {
  const pages = board(2, 5);
  const ctx = ctxOf(pages.map((rows) => html(rows.map(row), 45, '')));
  const jobs = await ap.fetch(ENTRY, ctx);
  assert.equal(ctx.calls.length, 3);
  assert.equal(statusOf(jobs), 'complete');
  assert.deepEqual(ctx.calls, [
    'https://jobs.apple.com/en-us/search?location=united-states-USA',
    'https://jobs.apple.com/en-us/search?location=united-states-USA&page=2',
    'https://jobs.apple.com/en-us/search?location=united-states-USA&page=3',
  ]);
});

test('a repeated page short of the total is page_failed, not the end of the list', async () => {
  const pages = board(2);
  const p1 = html(pages[0].map(row), 60);
  const ctx = ctxOf([p1, html(pages[1].map(row), 60), html(pages[1].map(row), 60)]);
  const { value: jobs, errs } = await quiet(() => ap.fetch(ENTRY, ctx));
  assert.equal(ctx.calls.length, 3);
  assert.equal(statusOf(jobs), 'page_failed');
  assert.ok(jobs.truncated);
  assert.ok(errs.some((e) => /truncated/.test(e)));
});

test('an empty page short of the total is page_failed', async () => {
  const pages = board(2);
  const { value: jobs } = await quiet(() => ap.fetch(ENTRY, ctxOf([html(pages[0].map(row), 60), html(pages[1].map(row), 60), html([], 60)])));
  assert.equal(statusOf(jobs), 'page_failed');
  assert.equal(jobs.truncated.reason, 'source-reports-more');
});

test('a malformed row read twice does not count twice: partly overlapping pages are not complete (Codex plan review r1)', async () => {
  const bad = { id: 'X', postingTitle: '' }; // skipped by parseResults, but it has a raw id
  const a = block('A', 19, NOW).map(row);
  const b = block('B', 19, NOW - 30 * 3_600_000).map(row);
  const ctx = ctxOf([html([...a, bad], 40), html([...b, bad], 40), html([], 40)]);
  const { value: jobs } = await quiet(() => ap.fetch(ENTRY, ctx));
  assert.equal(jobs.length, 38);
  assert.notEqual(statusOf(jobs), 'complete');
  assert.equal(statusOf(jobs), 'page_failed');
});

test('a row without an id can never prove the read complete', async () => {
  const rows = block('A', 19, NOW).map(row);
  const { value: jobs } = await quiet(() => ap.fetch(ENTRY, ctxOf([html([...rows, { postingTitle: 'no id' }], 19), html([], 19)])));
  assert.equal(jobs.length, 19);
  assert.equal(statusOf(jobs), 'unverified');
});

test('max_pages short of the total is ceiling', async () => {
  let n = 0;
  const ctx = ctxOf(() => html(block(`M${n++}-`, 20, NOW - n * DAY).map(row), 99999));
  const { value: jobs } = await quiet(() => ap.fetch({ ...ENTRY, max_pages: 3 }, ctx));
  assert.equal(ctx.calls.length, 3);
  assert.equal(statusOf(jobs), 'ceiling');
});

test('a page request that fails fails the list (no status to advance on)', async () => {
  const pages = board(4);
  const e = new Error('HTTP 503'); e.status = 503;
  const known = allIds(pages);
  known.delete('R0-0');
  const ctx = ctxOf((_url, i) => (i === 0 ? html(pages[0].map(row), 80) : e), { known });
  await assert.rejects(ap.fetch(ENTRY, ctx), /HTTP 503/);
  assert.ok(ctx.calls.length > 1, 'page 2 was asked (with retries) and failed');
});

test('only the verified board stops early; any other board keeps its request and reads to the end', async () => {
  const pages = board(6);
  for (const careers_url of [
    'https://jobs.apple.com/en-gb/search?location=united-states-USA',
    'https://jobs.apple.com/en-us/search?location=united-kingdom-GBR',
    'https://jobs.apple.com/en-us/search?location=united-states-USA&location=canada-CANC',
    'https://jobs.apple.com/en-us/search?location=united-states-USA&team=internships-STDNT-INTRN',
    'https://jobs.apple.com/en-us/search?location=united-states-USA&search=intern',
    'https://jobs.apple.com/en-us/search?location=united-states-USA&sort=relevance',
    'https://jobs.apple.com/en-us/search?team=internships-STDNT-INTRN',
  ]) {
    const ctx = ctxOf(pages.map((rows) => html(rows.map(row), 120)), { known: allIds(pages) });
    const jobs = await ap.fetch({ name: 'Apple', careers_url }, ctx);
    assert.equal(ctx.calls.length, 6, careers_url);
    assert.equal(statusOf(jobs), 'complete', careers_url);
    const sorts = ctx.calls.map((u) => new URL(u).searchParams.getAll('sort'));
    const expected = new URL(careers_url).searchParams.getAll('sort');
    for (const s of sorts) assert.deepEqual(s, expected, careers_url);
  }
});

test('an explicit sort=newest on the verified board is kept once and may stop', async () => {
  const pages = board(10);
  const ctx = ctxOf(pages.map((rows) => html(rows.map(row), 200)), { known: allIds(pages) });
  const jobs = await ap.fetch({ name: 'Apple', careers_url: `${ENTRY.careers_url}&sort=newest` }, ctx);
  assert.equal(statusOf(jobs), 'early_stopped');
  for (const url of ctx.calls) assert.deepEqual(new URL(url).searchParams.getAll('sort'), ['newest']);
});

test('without isKnownListing or a bound, or while probing, the walk never stops and the request is unchanged', async () => {
  const pages = board(6);
  const plain = (ctx) => ctx.calls.every((u) => !new URL(u).searchParams.has('sort'));
  const noBound = ctxOf(pages.map((rows) => html(rows.map(row), 120)), { known: allIds(pages), bound: null });
  assert.equal(statusOf(await ap.fetch(ENTRY, noBound)), 'complete');
  assert.equal(noBound.calls.length, 6);
  assert.ok(plain(noBound));
  const noKnown = ctxOf(pages.map((rows) => html(rows.map(row), 120)), { extra: { earlyStopBeforeMs: BOUND } });
  assert.equal(statusOf(await ap.fetch(ENTRY, noKnown)), 'complete');
  assert.ok(plain(noKnown));
  const probe = ctxOf(pages.map((rows) => html(rows.map(row), 120)), { known: allIds(pages), extra: { maxPages: 1 } });
  await quiet(() => ap.fetch(ENTRY, probe));
  assert.equal(probe.calls.length, 1);
  assert.ok(plain(probe));
});

test('an empty first page with a positive total is page_failed, never complete (Codex code review r1)', async () => {
  const { value: jobs } = await quiet(() => ap.fetch(ENTRY, ctxOf([html([], 60)])));
  assert.equal(jobs.length, 0);
  assert.equal(statusOf(jobs), 'page_failed');
  assert.ok(jobs.truncated);
  const empty = await ap.fetch(ENTRY, ctxOf([html([], 0)]));
  assert.equal(statusOf(empty), 'complete', 'a board that reports 0 and serves 0 is an empty board');
});

test('a row without an id turns the early stop off for the walk, on its own page or an earlier one (Codex code review r1)', async () => {
  for (const at of [4, 1]) {
    const pages = board(10);
    const rows = pages.map((r) => r.map(row));
    rows[at].splice(3, 0, { postingTitle: 'no id', postDateInGMT: iso(NOW - (20 * at + 3) * 3_600_000) });
    const ctx = ctxOf(rows.map((r) => html(r, 200)), { known: allIds(pages) });
    const { value: jobs } = await quiet(() => ap.fetch(ENTRY, ctx));
    assert.equal(ctx.calls.length, 10, `no early stop (anonymous row on page ${at + 1})`);
    assert.equal(statusOf(jobs), 'unverified');
  }
});
