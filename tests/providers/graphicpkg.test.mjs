// tests/providers/graphicpkg.test.mjs — Graphic Packaging career site
// (careers.graphicpkg.com): GET /api/mcp/jobs?tool=search_jobs JSON + sitemap.xml.
//
// Fixtures are trimmed live responses (2026-11-11: 3 of 262 rows, descriptions
// cut; 4 sitemap <loc> lines). No network is used — ctx is stubbed.
//
// Run:  node --test tests/providers/graphicpkg.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/graphicpkg.mjs')).href);
const gp = mod.default;
const { resolveConfig, buildSearchUrl, parseSearch, parseSitemap, fallbackJobUrl, toEpochMs, PAGE_SIZE, SITEMAP_URL } = mod;

const ENTRY = { name: 'Acme', careers_url: 'https://careers.graphicpkg.com/search-jobs', provider: 'graphicpkg' };

const PAGE1 = {
  tool: 'search_jobs',
  results: [
    {
      requisitionId: '14329', title: 'Press Operator Assistant', department: 'Manufacturing & Operations',
      location: 'Staunton, VA, USA', employmentType: 'Standard', datePosted: '2026-04-29',
      applyUrl: 'https://career55.sapsf.eu/careers?company=graphicpac&career_ns=job_application&career_job_req_id=14329',
      description: 'At Graphic Packaging International, we produce the paper cup',
    },
    {
      requisitionId: '15688', title: 'Engineering Intern', department: 'Engineering',
      location: 'Queen City, TX, USA', employmentType: 'Standard', datePosted: '2026-08-31',
      applyUrl: 'https://career55.sapsf.eu/careers?company=graphicpac&career_ns=job_application&career_job_req_id=15688',
      description: 'About Graphic&#13;At Graphic Packaging International',
    },
    {
      requisitionId: '16253', title: 'HS&amp;E Associate Manager', department: 'Health & Safety',
      location: 'Pineville, NC, USA', employmentType: 'Standard', datePosted: '2026-11-10',
      applyUrl: 'https://career55.sapsf.eu/careers?company=graphicpac&career_ns=job_application&career_job_req_id=16253',
      description: 'x',
    },
  ],
  totalCount: 3,
  page: 1,
  pageSize: 500,
  summary: 'Found 3 jobs',
};

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://careers.graphicpkg.com/engineering</loc></url>
<url><loc>https://careers.graphicpkg.com/job/27173/hs-e-associate-manager/Pineville-North-Carolina/career55rms/16253</loc></url>
<url><loc>https://careers.graphicpkg.com/job/27187/press-operator-assistant/Staunton-Virginia/career55rms/14329</loc></url>
<url><loc>https://evil.example/job/1/x/y/career55rms/15688</loc></url>
</urlset>`;

/** Synthetic search page with `n` rows from id `start`. */
function page(n, start, total) {
  return {
    tool: 'search_jobs', totalCount: total, page: 1, pageSize: PAGE_SIZE, summary: '',
    results: Array.from({ length: n }, (_, i) => ({ requisitionId: String(start + i), title: `Job ${start + i}`, location: 'Atlanta, GA, USA', datePosted: '2026-11-01' })),
  };
}

function makeCtx(jsonBodies, { sitemap = SITEMAP, ...extra } = {}) {
  const calls = [];
  let i = 0;
  return {
    calls,
    sleep: async () => {},
    fetchJson: async (url, opts) => {
      calls.push({ kind: 'json', url, opts });
      const b = jsonBodies[i++];
      if (b instanceof Error) throw b;
      return b === undefined ? page(0, 1, 0) : b;
    },
    fetchText: async (url, opts) => {
      calls.push({ kind: 'text', url, opts });
      if (sitemap instanceof Error) throw sitemap;
      return sitemap;
    },
    ...extra,
  };
}

async function quiet(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(' '));
  try { return { value: await fn(), lines }; } finally { console.error = orig; }
}

test('id; detect() never claims an entry (explicit provider only)', () => {
  assert.equal(gp.id, 'graphicpkg');
  assert.equal(gp.detect(ENTRY), null);
  assert.equal(gp.detect({}), null);
  assert.equal(gp.detect(null), null);
});

test('resolveConfig(): allowlisted https host only; no URL is fine', () => {
  assert.deepEqual(resolveConfig(ENTRY), { origin: 'https://careers.graphicpkg.com' });
  assert.deepEqual(resolveConfig({ name: 'Acme' }), { origin: 'https://careers.graphicpkg.com' });
  assert.throws(() => resolveConfig({ careers_url: 'https://evil.example/' }), /allowlist/);
  assert.throws(() => resolveConfig({ careers_url: 'https://careers.graphicpkg.com.evil.example/' }), /allowlist/);
  assert.throws(() => resolveConfig({ careers_url: 'http://careers.graphicpkg.com/' }), /non-https/);
  assert.throws(() => resolveConfig({ careers_url: 'https://u:p@careers.graphicpkg.com/' }), /credentials/);
  assert.throws(() => resolveConfig({ careers_url: 'https://careers.graphicpkg.com:8443/' }), /allowlist/);
  assert.throws(() => resolveConfig({ careers_url: 'not a url' }));
});

test('allowlist guard throws before any request', async () => {
  const ctx = makeCtx([PAGE1]);
  await assert.rejects(() => gp.fetch({ name: 'Acme', careers_url: 'https://evil.example/jobs' }, ctx), /allowlist/);
  assert.equal(ctx.calls.length, 0);
});

test('buildSearchUrl() / fallbackJobUrl()', () => {
  assert.equal(buildSearchUrl(2), `https://careers.graphicpkg.com/api/mcp/jobs?tool=search_jobs&page=2&pageSize=${PAGE_SIZE}`);
  assert.equal(fallbackJobUrl('15688'), 'https://careers.graphicpkg.com/job/15688');
  assert.equal(fallbackJobUrl('../x'), null);
  assert.equal(fallbackJobUrl('\uD800'), null);
});

test('parseSitemap(): requisitionId → canonical URL, foreign hosts and non-job pages dropped', () => {
  const m = parseSitemap(SITEMAP);
  assert.equal(m.size, 2);
  assert.equal(m.get('14329'), 'https://careers.graphicpkg.com/job/27187/press-operator-assistant/Staunton-Virginia/career55rms/14329');
  assert.equal(m.has('15688'), false);
  assert.equal(parseSitemap(null).size, 0);
});

test('toEpochMs(): NaN-safe', () => {
  assert.equal(toEpochMs('2026-04-29'), Date.UTC(2026, 3, 29));
  assert.equal(toEpochMs('garbage'), undefined);
  assert.equal(toEpochMs(''), undefined);
  assert.equal(toEpochMs(undefined), undefined);
});

test('fetch(): normalizes rows, canonical URL from sitemap, fallback URL otherwise, redirect: error everywhere', async () => {
  const ctx = makeCtx([PAGE1]);
  const jobs = await gp.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs[0], {
    title: 'Press Operator Assistant',
    url: 'https://careers.graphicpkg.com/job/27187/press-operator-assistant/Staunton-Virginia/career55rms/14329',
    company: 'Acme',
    location: 'Staunton, VA, USA',
    postedAt: Date.UTC(2026, 3, 29),
  });
  assert.equal(jobs[1].title, 'Engineering Intern');
  assert.equal(jobs[1].url, 'https://careers.graphicpkg.com/job/15688'); // not in sitemap (foreign-host loc ignored)
  assert.equal(jobs[2].title, 'HS&E Associate Manager'); // entity decoded
  assert.equal(jobs.truncated, undefined);
  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.calls[0].kind, 'json');
  assert.equal(ctx.calls[0].url, buildSearchUrl(1));
  assert.equal(ctx.calls[1].kind, 'text');
  assert.equal(ctx.calls[1].url, SITEMAP_URL);
  for (const c of ctx.calls) {
    assert.equal(c.opts.redirect, 'error');
    assert.equal(new URL(c.url).hostname, 'careers.graphicpkg.com');
  }
});

test('fetch(): rows missing requisitionId/title are filtered; duplicates deduped', async () => {
  const body = {
    ...PAGE1,
    totalCount: 2,
    results: [
      PAGE1.results[0],
      { ...PAGE1.results[0] },
      { requisitionId: '', title: 'No id' },
      { requisitionId: '999', title: '   ' },
      { requisitionId: 'abc', title: 'Bad id' },
      null,
      PAGE1.results[1],
    ],
  };
  const jobs = await gp.fetch(ENTRY, makeCtx([body]));
  assert.deepEqual(jobs.map((j) => j.title), ['Press Operator Assistant', 'Engineering Intern']);
  assert.equal(jobs.truncated, undefined);
});

test('fetch(): sitemap failure keeps the rows with fallback URLs', async () => {
  const { value: jobs, lines } = await quiet(() => gp.fetch(ENTRY, makeCtx([PAGE1], { sitemap: Object.assign(new Error('HTTP 404'), { status: 404 }) })));
  assert.equal(jobs.length, 3);
  assert.equal(jobs[0].url, 'https://careers.graphicpkg.com/job/14329');
  assert.match(lines.join('\n'), /sitemap failed/);
});

test('empty / contentless body → []; wrong shape → descriptive throw', async () => {
  for (const b of [null, {}, { results: null }, page(0, 1, 0)]) {
    const ctx = makeCtx([b]);
    assert.deepEqual(await gp.fetch(ENTRY, ctx), []);
    assert.equal(ctx.calls.filter((c) => c.kind === 'text').length, 0); // no sitemap read for an empty board
  }
  await assert.rejects(() => gp.fetch(ENTRY, makeCtx([{ jobs: [] }])), /no results array; keys: jobs/);
  await assert.rejects(() => gp.fetch(ENTRY, makeCtx([[1, 2]])), /unexpected search_jobs response \(array\)/);
  await assert.rejects(() => gp.fetch(ENTRY, makeCtx([{ results: [{ id: 1, name: 'x' }], totalCount: 1 }])), /no job rows parsed/);
  assert.throws(() => parseSearch('<html>'), /not JSON/);
});

test('pagination: stops on a short page, on the total, and on a page with nothing new', async () => {
  const ctxShort = makeCtx([page(PAGE_SIZE, 1, 2 * PAGE_SIZE + 5), page(5, PAGE_SIZE + 1, 2 * PAGE_SIZE + 5)]);
  const { value: short } = await quiet(() => gp.fetch(ENTRY, ctxShort));
  assert.equal(short.length, PAGE_SIZE + 5);
  assert.equal(ctxShort.calls.filter((c) => c.kind === 'json').length, 2);
  assert.equal(short.truncated, true); // fewer unique rows than totalCount

  const ctxTotal = makeCtx([page(PAGE_SIZE, 1, PAGE_SIZE)]);
  const total = await gp.fetch(ENTRY, ctxTotal);
  assert.equal(total.length, PAGE_SIZE);
  assert.equal(ctxTotal.calls.filter((c) => c.kind === 'json').length, 1);
  assert.equal(total.truncated, undefined);

  const ctxSame = makeCtx([page(PAGE_SIZE, 1, 5000), page(PAGE_SIZE, 1, 5000)]);
  const { value: same } = await quiet(() => gp.fetch(ENTRY, ctxSame));
  assert.equal(same.length, PAGE_SIZE);
  assert.equal(ctxSame.calls.filter((c) => c.kind === 'json').length, 2);
  assert.equal(same.truncated, true);
});

test('pagination: own page cap stops a board that reports more, warns and sets truncated', async () => {
  const pages = Array.from({ length: 10 }, (_, k) => page(PAGE_SIZE, 1 + k * PAGE_SIZE, 100_000));
  const ctx = makeCtx(pages);
  const { value: jobs, lines } = await quiet(() => gp.fetch(ENTRY, ctx));
  assert.equal(ctx.calls.filter((c) => c.kind === 'json').length, 4); // DEFAULT_MAX_PAGES
  assert.equal(jobs.length, 4 * PAGE_SIZE);
  assert.equal(jobs.truncated, true);
  assert.match(lines.join('\n'), /raise max_pages/);

  const ctx2 = makeCtx(pages);
  const { value: two } = await quiet(() => gp.fetch({ ...ENTRY, max_pages: 2 }, ctx2));
  assert.equal(two.length, 2 * PAGE_SIZE);
  assert.equal(two.truncated, true);
});

test('page-2 failure keeps page 1, sets truncated, no "raise max_pages" warning', async () => {
  const err = Object.assign(new Error('HTTP 404'), { status: 404 });
  const { value: jobs, lines } = await quiet(() => gp.fetch(ENTRY, makeCtx([page(PAGE_SIZE, 1, 2 * PAGE_SIZE), err])));
  assert.equal(jobs.length, PAGE_SIZE);
  assert.equal(jobs.truncated, true);
  assert.doesNotMatch(lines.join('\n'), /raise max_pages/);
  await assert.rejects(() => gp.fetch(ENTRY, makeCtx([err])), (e) => e === err); // page 1 failure is fatal
});

test('probe: ctx.maxPages 1 → one list request, no sitemap; rejection propagates unwrapped', async () => {
  const ctx = makeCtx([page(PAGE_SIZE, 1, 5000), page(PAGE_SIZE, PAGE_SIZE + 1, 5000)], { maxPages: 1 });
  const jobs = await gp.fetch(ENTRY, ctx);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].kind, 'json');
  assert.equal(jobs.length, PAGE_SIZE);
  assert.equal(jobs[0].url, 'https://careers.graphicpkg.com/job/1');
  class ProbePageBudgetReached extends Error {}
  const err = new ProbePageBudgetReached('budget');
  await assert.rejects(() => gp.fetch(ENTRY, makeCtx([err, err, err], { maxPages: 1 })), (e) => e === err);
});
