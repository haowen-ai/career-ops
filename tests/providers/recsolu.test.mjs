// tests/providers/recsolu.test.mjs — Recsolu (Yello) job boards
// (GET /job_boards/{id}/search JSON with an HTML fragment).
//
// The fixture is a trimmed live response (2026-11-07, Kearney board 1 with the
// United States filter 12240; 3 of 46 rows). No network — ctx is stubbed.
//
// Run:  node --test tests/providers/recsolu.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/recsolu.mjs')).href);
const rs = mod.default;
const { resolveConfig, buildSearchUrl, parseSearchResponse, parsePostTime } = mod;

const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/recsolu-search.json'), 'utf8'));
const URL_US = 'https://kearney.recsolu.com/job_boards/1?filters=12240';
const ENTRY = { name: 'Acme', careers_url: URL_US };
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const CFG = { origin: 'https://kearney.recsolu.com', board: '1', filters: '12240' };
const DAY = 86_400_000;

function row(slug, title, spans = ['Full-time', 'Americas', 'Chicago'], post = '1w') {
  return `<li class="search-results__item"><div class="clearfix"><div class="search-results__jobinfo pull-left"><a class="search-results__req_title" lang="en" href="/jobs/${slug}?job_board_id=BOARDslug">${title}</a><div>${spans.map((s) => `<span>${s}</span>`).join('')}</div></div><div class="search-results__post-time pull-right">${post}</div></div></li>`;
}

/** Synthetic page with `n` rows starting at `start`. */
function page(n, start, more = true) {
  return { html: Array.from({ length: n }, (_, i) => row(`s${start + i}`, `Job ${start + i}`)).join(''), count_on_page: n, more_requisitions: more, query: '', filters: '[]', text_filters: '[]', display_count_text: -1 };
}

function makeCtx(bodies, extra = {}) {
  const calls = [];
  let i = 0;
  return {
    calls,
    now: () => NOW,
    sleep: async () => {},
    fetchJson: async (url, opts) => {
      calls.push({ url, opts });
      const b = bodies[i++];
      if (b instanceof Error) throw b;
      return b === undefined ? page(0, 0, false) : b;
    },
    ...extra,
  };
}

test('id', () => {
  assert.equal(rs.id, 'recsolu');
});

test('detect(): claims only https {tenant}.recsolu.com/job_boards/{id}', () => {
  assert.deepEqual(rs.detect({ careers_url: URL_US }), { url: URL_US });
  for (const bad of ['http://kearney.recsolu.com/job_boards/1', 'https://evil.example/job_boards/1', 'https://kearney.recsolu.com.evil.example/job_boards/1', 'https://assets.us.recsolu.com/job_boards/1', 'https://assets.recsolu.com/job_boards/1', 'https://kearney.recsolu.com/jobs/abc', 'https://kearney.recsolu.com/job_boards/1?filters=US', 'nope', '']) {
    assert.equal(rs.detect({ careers_url: bad }), null, bad);
  }
  assert.equal(rs.detect({}), null);
  assert.equal(rs.detect({ careers_url: 7 }), null);
  assert.equal(rs.detect(null), null);
});

test('resolveConfig(): board id + filters from query or entry (entry wins)', () => {
  assert.deepEqual(resolveConfig(ENTRY), CFG);
  assert.equal(resolveConfig({ careers_url: 'https://kearney.recsolu.com/job_boards/EPd41qlA4_03IncZMnWyRQ' }).board, 'EPd41qlA4_03IncZMnWyRQ');
  assert.equal(resolveConfig({ careers_url: 'https://kearney.recsolu.com/job_boards/1' }).filters, '');
  assert.equal(resolveConfig({ careers_url: URL_US, filters: [12240, 12166] }).filters, '12240,12166');
  assert.equal(resolveConfig({ careers_url: URL_US, filters: '12166' }).filters, '12166');
  assert.throws(() => resolveConfig({ careers_url: URL_US, filters: '1;drop' }), /numeric ids/);
});

test('buildSearchUrl(): same origin, board, filters, 1-based page_number', () => {
  const u = new URL(buildSearchUrl(CFG, 2));
  assert.equal(u.origin + u.pathname, 'https://kearney.recsolu.com/job_boards/1/search');
  assert.equal(u.searchParams.get('filters'), '12240');
  assert.equal(u.searchParams.get('query'), '');
  assert.equal(u.searchParams.get('page_number'), '2');
});

test('parsePostTime(): relative and month-day forms', () => {
  assert.equal(parsePostTime('NEW', NOW), NOW);
  assert.equal(parsePostTime('3d', NOW), NOW - 3 * DAY);
  assert.equal(parsePostTime('2w', NOW), NOW - 14 * DAY);
  assert.equal(parsePostTime('Oct 9', NOW), Date.UTC(2026, 9, 9));
  assert.equal(parsePostTime('Dec 20', NOW), Date.UTC(2025, 11, 20)); // future → last year
  assert.equal(parsePostTime('Feb 30', NOW), undefined);
  assert.equal(parsePostTime('soon', NOW), undefined);
  assert.equal(parsePostTime(undefined, NOW), undefined);
});

test('parseSearchResponse(): real fixture rows, entities decoded', () => {
  const { rows, count, more } = parseSearchResponse(FIXTURE, CFG, NOW);
  assert.equal(count, 3);
  assert.equal(more, false);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].title, 'Kearney Manager, Digital Operations, Supply Chain Design & Optimization');
  assert.equal(rows[0].url, 'https://kearney.recsolu.com/jobs/A76oF2GWzNWY5IpNh7pDZw?job_board_id=EPd41qlA4_03IncZMnWyRQ');
  assert.match(rows[0].location, /^Americas, Atlanta, Boston, Chicago/);
  assert.equal(rows[0].postedAt, NOW);
  assert.equal(rows[1].title, 'Kearney Summer Associate 2027');
  assert.equal(rows[1].postedAt, Date.UTC(2026, 8, 26));
  assert.equal(rows[2].postedAt, NOW - 3 * DAY);
});

test('parseSearchResponse(): malformed rows skipped, batch survives', () => {
  const html = [
    '<li class="search-results__item"><div>no link</div></li>',
    row('bad/slug', 'Bad slug'),
    row('ok1', '   '),
    '<li class="search-results__item"><a class="search-results__req_title" href="https://evil.example/jobs/x">Off-site</a></li>',
    row('ok2', 'R&amp;D Intern', ['Intern/Trainee'], '???'),
    row('ok3', 'Analyst'),
  ].join('');
  const { rows } = parseSearchResponse({ html, count_on_page: 6, more_requisitions: false }, CFG, NOW);
  assert.deepEqual(rows.map((r) => r.title), ['R&D Intern', 'Analyst']);
  assert.equal(rows[0].location, '');
  assert.equal(rows[0].postedAt, undefined);
  assert.equal(rows[1].url, 'https://kearney.recsolu.com/jobs/ok3?job_board_id=BOARDslug');
});

test('parseSearchResponse(): error envelope / wrong types / markup drift → descriptive throw', () => {
  assert.throws(() => parseSearchResponse({ status: 404, error: 'Not Found' }, CFG, NOW), /unexpected search response shape \(keys: status, error\) — Not Found/);
  assert.throws(() => parseSearchResponse({ html: ['x'], count_on_page: 1 }, CFG, NOW), /unexpected search response shape/);
  assert.throws(() => parseSearchResponse({ html: '', count_on_page: '3' }, CFG, NOW), /unexpected search response shape/);
  assert.throws(() => parseSearchResponse({}, CFG, NOW), /keys: none/);
  assert.throws(() => parseSearchResponse(null, CFG, NOW), /unexpected search response/);
  assert.throws(() => parseSearchResponse([], CFG, NOW), /array/);
  assert.throws(() => parseSearchResponse({ html: '<div class="new-markup">x</div>', count_on_page: 5 }, CFG, NOW), /markup changed/);
  assert.equal(parseSearchResponse({ html: '', count_on_page: 0, more_requisitions: false }, CFG, NOW).rows.length, 0);
});

test('fetch(): normalized rows, redirect:error on every request', async () => {
  const ctx = makeCtx([FIXTURE]);
  const jobs = await rs.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 3);
  assert.deepEqual(Object.keys(jobs[0]).sort(), ['company', 'location', 'postedAt', 'title', 'url']);
  assert.equal(jobs[0].company, 'Acme');
  assert.equal(ctx.calls.length, 1);
  for (const c of ctx.calls) {
    assert.equal(c.opts.redirect, 'error');
    assert.equal(new URL(c.url).hostname, 'kearney.recsolu.com');
  }
});

test('fetch(): host guard throws before any request', async () => {
  for (const careers_url of ['https://evil.example/job_boards/1', 'http://kearney.recsolu.com/job_boards/1', 'https://kearney.recsolu.com/', 'nope']) {
    const ctx = makeCtx([FIXTURE]);
    await assert.rejects(() => rs.fetch({ name: 'Acme', careers_url }, ctx));
    assert.equal(ctx.calls.length, 0, careers_url);
  }
});

test('fetch(): genuine zero → []; error envelope / non-2xx → throw', async () => {
  assert.deepEqual(await rs.fetch(ENTRY, makeCtx([page(0, 0, false)])), []);
  await assert.rejects(() => rs.fetch(ENTRY, makeCtx([{ status: 404, error: 'Not Found' }])), /unexpected search response shape/);
  const e404 = Object.assign(new Error('HTTP 404 Not Found'), { status: 404 });
  await assert.rejects(() => rs.fetch(ENTRY, makeCtx([e404])), /HTTP 404/);
});

test('fetch(): paginates by page_number until more_requisitions is false', async () => {
  const ctx = makeCtx([page(25, 1), page(25, 26), page(10, 51, false)]);
  const jobs = await rs.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 60);
  assert.deepEqual(ctx.calls.map((c) => new URL(c.url).searchParams.get('page_number')), ['1', '2', '3']);
});

test('fetch(): stops when a page repeats (no fresh rows)', async () => {
  const ctx = makeCtx([page(25, 1), page(25, 1), page(25, 1)]);
  const jobs = await rs.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 25);
  assert.equal(ctx.calls.length, 2);
});

test('fetch(): DEFAULT_MAX_PAGES / max_pages ceiling stops an endless board, and warns', async () => {
  const bodies = Array.from({ length: 300 }, (_, k) => page(25, k * 25 + 1));
  const orig = console.error;
  const msgs = [];
  console.error = (m) => msgs.push(String(m));
  try {
    const ctx = makeCtx(bodies);
    assert.equal((await rs.fetch(ENTRY, ctx)).length, 1000);
    assert.equal(ctx.calls.length, 40);
    const ctx2 = makeCtx(bodies);
    await rs.fetch({ ...ENTRY, max_pages: 99999 }, ctx2);
    assert.equal(ctx2.calls.length, 200);
  } finally {
    console.error = orig;
  }
  assert.ok(msgs.some((m) => /raise max_pages/.test(m)));
});

test('fetch(): ctx.maxPages=1 → one request, no warning; rejection propagates unwrapped', async () => {
  const ctx = makeCtx([page(25, 1), page(25, 26)], { maxPages: 1 });
  const orig = console.error;
  const msgs = [];
  console.error = (m) => msgs.push(String(m));
  try {
    assert.equal((await rs.fetch(ENTRY, ctx)).length, 25);
    assert.equal(ctx.calls.length, 1);
  } finally {
    console.error = orig;
  }
  assert.equal(msgs.length, 0);
  class ProbePageBudgetReached extends Error {}
  const sentinel = new ProbePageBudgetReached('budget');
  await assert.rejects(() => rs.fetch(ENTRY, makeCtx([sentinel, sentinel, sentinel], { maxPages: 1 })), (e) => e === sentinel);
});

test('fetch(): page-2 failure after retries fails loud, no max_pages warning', async () => {
  const e503 = Object.assign(new Error('HTTP 503'), { status: 503 });
  const orig = console.error;
  const msgs = [];
  console.error = (m) => msgs.push(String(m));
  try {
    await assert.rejects(() => rs.fetch(ENTRY, makeCtx([page(25, 1), e503, e503, e503])), /page 2 failed \(HTTP 503\) after 25 postings/);
  } finally {
    console.error = orig;
  }
  assert.ok(!msgs.some((m) => /raise max_pages/.test(m)));
});
