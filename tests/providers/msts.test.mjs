// tests/providers/msts.test.mjs — msts career-site CMS (careers.lennar.com):
// GET /api/requisitions/search/{lang}?page=N HTML fragment.
//
// The fixture is a trimmed live fragment (2026-11-07, page 2: header + 3 of
// 363 rows). No network is used — ctx is stubbed.
//
// Run:  node --test tests/providers/msts.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/msts.mjs')).href);
const ms = mod.default;
const { resolveConfig, buildSearchUrl, parseResults, toEpochMs } = mod;

const FIXTURE = readFileSync(join(ROOT, 'tests/fixtures/msts-search-page.html'), 'utf8');
const ENTRY = { name: 'Acme', careers_url: 'https://careers.lennar.com/search' };
const CFG = resolveConfig(ENTRY);

function row(id, title, host = 'careers.lennar.com', loc = 'Miami, FL', date = '11/06/2026') {
  return `<tr><td class="job-title"><a href="https://${host}/job/${id}/slug?change_lang=en">${title}</a></td>`
    + `<td class="job-location"><svg><title>address</title></svg> ${loc}</td><td class="job-date"> ${date} </td></tr>`;
}
/** Synthetic fragment: `n` rows from id `start`, header says `total`. */
function page(n, start, total) {
  const rows = Array.from({ length: n }, (_, i) => row(start + i, `Job ${start + i}`)).join('\n');
  return `<h3 class="job-search-results-info text-center">Results (${start}–${start + n - 1} of ${total})</h3>`
    + `<table role="grid"><thead><tr><th class="job-title">Job Title</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function makeCtx(bodies, extra = {}) {
  const calls = [];
  let i = 0;
  return {
    calls,
    sleep: async () => {},
    fetchText: async (url, opts) => {
      calls.push({ url, opts });
      const b = bodies[i++];
      if (b instanceof Error) throw b;
      return b === undefined ? page(0, 1, 0) : b;
    },
    ...extra,
  };
}

test('id; detect() never claims an entry (explicit provider only)', () => {
  assert.equal(ms.id, 'msts');
  assert.equal(ms.detect(ENTRY), null);
});

test('resolveConfig()/buildSearchUrl(): careers_url origin, https only, form keys forwarded', () => {
  assert.equal(buildSearchUrl(CFG, 2), 'https://careers.lennar.com/api/requisitions/search/en?page=2');
  const c = resolveConfig({ careers_url: 'https://careers.lennar.com/search?keywords=intern&utm=x&subdivision_code=FL', lang: 'es' });
  const u = new URL(buildSearchUrl(c, 1));
  assert.equal(u.pathname, '/api/requisitions/search/es');
  assert.equal(u.searchParams.get('keywords'), 'intern');
  assert.equal(u.searchParams.get('subdivision_code'), 'FL');
  assert.equal(u.searchParams.get('utm'), null);
  for (const bad of ['http://careers.lennar.com/', 'nope', '', 'https://a:b@careers.lennar.com/']) {
    assert.throws(() => resolveConfig({ careers_url: bad }), undefined, bad);
  }
});

test('parseResults(): real fixture rows', () => {
  const { rows, total, rawCount } = parseResults(FIXTURE, CFG);
  assert.equal(total, 363);
  assert.equal(rawCount, 3);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].title, 'Bilingual Purchasing Coordinator');
  assert.equal(rows[0].url, 'https://careers.lennar.com/job/2065/bilingual_purchasing_coordinator?change_lang=en');
  assert.equal(rows[0].location, 'Houston, TX');
  assert.equal(rows[0].postedAt, Date.UTC(2026, 10, 6));
  assert.equal(rows[0].id, '2065');
});

test('parseResults(): malformed rows skipped, foreign host rejected, entities decoded, bad date dropped', () => {
  const html = page(0, 1, 5).replace('</tbody>', [
    row(1, ''),
    row(2, 'Evil', 'evil.example'),
    '<tr><td class="job-title"><a href="https://careers.lennar.com/about">No id</a></td></tr>',
    row(3, 'R&amp;D Intern', 'careers.lennar.com', 'Austin, TX', '13/45/2026'),
    row(3, 'Duplicate'),
  ].join('') + '</tbody>');
  const { rows, rawCount } = parseResults(html, CFG);
  assert.equal(rawCount, 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'R&D Intern');
  assert.equal(rows[0].location, 'Austin, TX');
  assert.equal(rows[0].postedAt, undefined);
  assert.equal(toEpochMs('garbage'), undefined);
});

test('parseResults(): past-the-end page → empty; non-HTML or no header → throw', () => {
  const end = '<h3 class="job-search-results-info text-center">Results (371–370 of 363)</h3>';
  assert.equal(parseResults(end, CFG).rows.length, 0);
  assert.throws(() => parseResults(null, CFG), /expected HTML/);
  assert.throws(() => parseResults({ error: 'x' }, CFG), /expected HTML/);
  assert.throws(() => parseResults('<html>Maintenance</html>', CFG), /no results header/);
});

test('fetch(): normalized rows, redirect:error, stops at the reported total', async () => {
  const ctx = makeCtx([page(10, 1, 25), page(10, 11, 25), page(5, 21, 25), page(10, 99, 25)]);
  const jobs = await ms.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 25);
  assert.deepEqual(Object.keys(jobs[0]).sort(), ['company', 'location', 'postedAt', 'title', 'url']);
  assert.equal(ctx.calls.length, 3);
  for (const c of ctx.calls) assert.equal(c.opts.redirect, 'error');
  assert.deepEqual(ctx.calls.map((c) => new URL(c.url).searchParams.get('page')), ['1', '2', '3']);
});

test('fetch(): bad URL throws before any request', async () => {
  for (const careers_url of ['http://careers.lennar.com/', 'nope']) {
    const ctx = makeCtx([FIXTURE]);
    await assert.rejects(() => ms.fetch({ name: 'Acme', careers_url }, ctx));
    assert.equal(ctx.calls.length, 0);
  }
});

test('fetch(): genuine zero → []; unexpected page 1 → throw', async () => {
  assert.deepEqual(await ms.fetch(ENTRY, makeCtx([page(0, 1, 0)])), []);
  await assert.rejects(() => ms.fetch(ENTRY, makeCtx(['<html>Access denied</html>'])), /no results header/);
});

test('fetch(): max_pages ceiling, warning; ctx.maxPages=1 → one request; probe error unwrapped', async () => {
  const pages = Array.from({ length: 100 }, (_, p) => page(10, p * 10 + 1, 9_999_999));
  const warnings = [];
  const real = console.error;
  console.error = (m) => warnings.push(String(m));
  try {
    const ctx = makeCtx(pages);
    await ms.fetch(ENTRY, ctx);
    assert.equal(ctx.calls.length, 80);
    const ctx2 = makeCtx(pages);
    await ms.fetch({ ...ENTRY, max_pages: 2 }, ctx2);
    assert.equal(ctx2.calls.length, 2);
    assert.ok(warnings.some((w) => /raise max_pages/.test(w)));
    warnings.length = 0;
    const ctx3 = makeCtx(pages, { maxPages: 1 });
    assert.equal((await ms.fetch(ENTRY, ctx3)).length, 10);
    assert.equal(ctx3.calls.length, 1);
    assert.equal(warnings.length, 0);
  } finally {
    console.error = real;
  }
  class ProbePageBudgetReached extends Error {}
  const err = new ProbePageBudgetReached('budget');
  await assert.rejects(() => ms.fetch(ENTRY, makeCtx([err, err, err], { maxPages: 1 })), (e) => e === err);
});

test('fetch(): page-2 failure keeps page 1; page-1 failure throws', async () => {
  const busy = Object.assign(new Error('HTTP 503'), { status: 503 });
  const real = console.error;
  console.error = () => {};
  try {
    assert.equal((await ms.fetch(ENTRY, makeCtx([page(10, 1, 30), busy, busy, busy]))).length, 10);
  } finally {
    console.error = real;
  }
  const bad = Object.assign(new Error('HTTP 404'), { status: 404 });
  await assert.rejects(() => ms.fetch(ENTRY, makeCtx([bad])), /404/);
});

test('regression: hostname allowlist — a host outside it throws before any request', async () => {
  // review 2 #4: https://evil.example/search used to be fetched
  for (const careers_url of ['https://evil.example/search', 'https://careers.lennar.com.evil.example/search', 'https://jobs.lennar.com/search', 'https://careers.lennar.com:8443/search']) {
    assert.throws(() => resolveConfig({ careers_url }), /not in the allowlist/, careers_url);
    const ctx = makeCtx([page(1, 1, 1)]);
    await assert.rejects(() => ms.fetch({ name: 'X', careers_url }, ctx), /not in the allowlist/);
    assert.equal(ctx.calls.length, 0, careers_url);
  }
  assert.deepEqual([...mod.ALLOWED_HOSTS], ['careers.lennar.com', 'www.seeacareerwithus.com']);
  assert.deepEqual([...mod.JOBS_FEED_HOSTS], ['www.seeacareerwithus.com']);
  assert.equal(resolveConfig(ENTRY).feed, false);
});

test('regression: positive results count with no parsable rows → parse error, not []', async () => {
  // review 2 #5: "Results (1–10 of 363)" with changed row markup returned [] silently
  const changed = '<h3 class="job-search-results-info">Results (1–10 of 363)</h3><div class="new-job-cards"><div class="card">Job</div></div>';
  assert.throws(() => parseResults(changed, CFG), /reports 363 jobs .* but no job rows parsed/);
  await assert.rejects(() => ms.fetch(ENTRY, makeCtx([changed])), /no job rows parsed/);
  // job-title cells present but every link unusable (foreign host) → also a parse error
  const foreign = page(0, 1, 5).replace('</tbody>', `${row(1, 'X', 'evil.example')}</tbody>`).replace('Results (1–0 of 5)', 'Results (1–1 of 5)');
  assert.throws(() => parseResults(foreign, CFG), /no job rows parsed \(1 job-title cells/);
  // genuine zero and past-the-end stay empty
  assert.equal(parseResults(page(0, 1, 0), CFG).rows.length, 0);
  assert.equal(parseResults(page(0, 371, 363), CFG).rows.length, 0);
});

// ── "autojob" /api/jobs feed (www.seeacareerwithus.com, IKEA US) ──────────
// Trimmed live response (2026-11-11: 3 of 125 rows, descriptions shortened).
const FEED = JSON.stringify({
  draw: null, recordsTotal: 125, recordsFiltered: 125,
  data: [
    { id: 125, job_id: '376912', name: 'Retail Carts Attendant Part-Time', description: '<h3>Why we will love you</h3>…', category: 'Customer Relations', country: 'United States', state: 'California', city: 'Burbank, California', url: 'https://ikea.avature.net/en_US/External/ApplicationMethods?jobId=376912', active: 1, posted_at: '2026-11-11T12:44:06.000000Z', location: 'Burbank, California', job_req: '376912' },
    { id: 124, job_id: '366983', name: 'Food & Dishwashing Co-Worker (Part-Time)', description: '…', state: 'Wisconsin', city: 'Oak Creek, Wisconsin', active: 1, posted_at: '2026-11-10T12:44:06.000000Z', location: 'Oak Creek, Wisconsin' },
    { id: 123, job_id: '368990', name: 'Seasonal Retail Store Associate Full Time', description: '…', state: 'Illinois', city: 'Gurnee, Illinois', active: 1, posted_at: '2026-11-10T12:44:06.000000Z', location: 'Gurnee, Illinois' },
  ],
  args: { empty: 'empty', orderby: 'posted_at desc', offset: null, limit: null },
});
const IKEA = { name: 'IKEA US', careers_url: 'https://www.seeacareerwithus.com/search-jobs' };

test('feed host: one GET to /api/jobs, rows normalized to /details/{id}/{slug}', async () => {
  const cfg = resolveConfig(IKEA);
  assert.equal(cfg.feed, true);
  assert.equal(mod.buildFeedUrl(cfg), 'https://www.seeacareerwithus.com/api/jobs?empty=empty');
  const ctx = makeCtx([FEED]);
  const real = console.error;
  const warnings = [];
  console.error = (m) => warnings.push(m);
  let jobs;
  try { jobs = await ms.fetch(IKEA, ctx); } finally { console.error = real; }
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].url, 'https://www.seeacareerwithus.com/api/jobs?empty=empty');
  assert.equal(ctx.calls[0].opts.redirect, 'error');
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs[0], {
    title: 'Retail Carts Attendant Part-Time',
    url: 'https://www.seeacareerwithus.com/details/376912/Retail-Carts-Attendant-Part-Time',
    company: 'IKEA US',
    location: 'Burbank, California',
    postedAt: Date.UTC(2026, 10, 11, 12, 44, 6),
  });
  assert.equal(jobs[1].url, 'https://www.seeacareerwithus.com/details/366983/Food---Dishwashing-Co-Worker--Part-Time-');
  assert.equal(jobs[1].title, 'Food & Dishwashing Co-Worker (Part-Time)');
  // fixture holds 3 of 125 → the shortfall is reported, not hidden
  assert.match(warnings.join('\n'), /jobs feed gave 3 of 125/);
});

test('feed host: malformed rows skipped; inactive dropped; shape change throws; zero is empty', () => {
  const cfg = resolveConfig(IKEA);
  const body = { recordsTotal: 4, data: [
    { job_id: 'abc', name: 'Bad id' },
    { job_id: '1', name: '' },
    { job_id: '2', name: 'Off', active: 0 },
    { job_id: '3', name: 'IT Intern', city: 'Conshohocken', state: 'Pennsylvania', posted_at: 'garbage' },
    { job_id: '3', name: 'Duplicate' },
  ] };
  const { rows } = mod.parseFeed(body, cfg);
  assert.deepEqual(rows, [{ id: '3', title: 'IT Intern', url: 'https://www.seeacareerwithus.com/details/3/IT-Intern', location: 'Conshohocken, Pennsylvania' }]);
  assert.throws(() => mod.parseFeed('<html>Maintenance</html>', cfg), /not JSON/);
  assert.throws(() => mod.parseFeed({ error: 'x' }, cfg), /no data array/);
  assert.throws(() => mod.parseFeed({ recordsTotal: 125, data: [{ jobId: 1, title: 'renamed' }] }, cfg), /reports 125 jobs but no job rows parsed/);
  assert.deepEqual(mod.parseFeed({ recordsTotal: 0, data: [] }, cfg).rows, []);
});

test('msts jobs feed marks the result truncated when max_jobs cuts valid rows', async () => {
  const feed = JSON.stringify({ recordsTotal: 2, data: [
    { job_id: 1, name: 'Role One', location: 'A', active: 1 },
    { job_id: 2, name: 'Role Two', location: 'B', active: 1 },
  ] });
  const ctx = { fetchText: async () => feed, sleep: async () => {} };
  const { default: provider } = await import('../../providers/msts.mjs');
  const cut = await provider.fetch({ name: 'IKEA US', careers_url: 'https://www.seeacareerwithus.com/search-jobs', max_jobs: 1 }, ctx);
  assert.equal(cut.length, 1);
  assert.equal(cut.truncated, true);
  const full = await provider.fetch({ name: 'IKEA US', careers_url: 'https://www.seeacareerwithus.com/search-jobs' }, ctx);
  assert.equal(full.length, 2);
  assert.equal(full.truncated, undefined);
});
