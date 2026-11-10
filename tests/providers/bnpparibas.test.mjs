// tests/providers/bnpparibas.test.mjs — BNP Paribas group careers
// (server-rendered /en/careers/all-job-offers/{facet} list pages).
//
// The fixture is a trimmed live US page (2026-11-07): the real result counter
// (38) and the first 3 of its 10 offer cards. No network — ctx is stubbed.
//
// Run:  node --test tests/providers/bnpparibas.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/bnpparibas.mjs')).href);
const bnp = mod.default;
const { resolveListUrl, buildPageUrl, parseListPage } = mod;

const FIXTURE = readFileSync(join(ROOT, 'tests/fixtures/bnpparibas-us-page.html'), 'utf8');
const US_URL = 'https://group.bnpparibas/en/careers/all-job-offers/united-states';
const ENTRY = { name: 'BNP Paribas', careers_url: US_URL };

/** Synthetic list page: `n` cards starting at `start`, counter `total`. */
function page(n, start, total) {
  const cards = Array.from({ length: n }, (_, i) => `<li class="type type-2"><article class="card-custom card-offer category-2">
    <a href="/en/careers/job-offer/job-${start + i}" class="card-link"><div class="offer-type">Permanent</div>
    <h3 class="title-4">Job ${start + i}</h3><div class="offer-location"><span class="icon"></span> New York, New York, United States </div></a></article></li>`);
  return `<h2 class="title-2 rh"><span class="nb-total spanGreen">${total.toLocaleString('en-US')}</span> job offers</h2><ul class="results rh-results">${cards.join('')}</ul>`;
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
      if (b === undefined) throw new Error(`unexpected extra request ${url}`);
      return b;
    },
    ...extra,
  };
}

test('id', () => {
  assert.equal(bnp.id, 'bnpparibas');
});

test('detect(): claims only https group.bnpparibas job-offer list pages', () => {
  assert.deepEqual(bnp.detect(ENTRY), { url: US_URL });
  assert.deepEqual(bnp.detect({ careers_url: 'https://group.bnpparibas/en/careers/all-job-offers' }), { url: 'https://group.bnpparibas/en/careers/all-job-offers' });
  for (const bad of [
    'http://group.bnpparibas/en/careers/all-job-offers',
    'https://evil.example/en/careers/all-job-offers',
    'https://group.bnpparibas.evil.example/en/careers/all-job-offers',
    'https://group.bnpparibas/en/careers/job-offer/x',
    'https://group.bnpparibas/en/careers/all-job-offers/a/b/c/d',
    'nope',
    '',
  ]) {
    assert.equal(bnp.detect({ careers_url: bad }), null, bad);
  }
  assert.equal(bnp.detect({}), null);
  assert.equal(bnp.detect({ careers_url: 7 }), null);
  assert.equal(bnp.detect(null), null);
});

test('resolveListUrl()/buildPageUrl(): query dropped, page 1 bare, page N ?page=N', () => {
  assert.equal(resolveListUrl({ careers_url: `${US_URL}/?page=3&x=1` }), US_URL);
  assert.equal(buildPageUrl(US_URL, 1), US_URL);
  assert.equal(buildPageUrl(US_URL, 4), `${US_URL}?page=4`);
});

test('parseListPage(): real fixture — counter, cards, entities decoded', () => {
  const { total, rows, rawCount } = parseListPage(FIXTURE);
  assert.equal(total, 38);
  assert.equal(rawCount, 3);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].title, '2028 - Summer Analyst Internship – Global Banking, Asset Finance & Securitization');
  assert.equal(rows[0].url, 'https://group.bnpparibas/en/careers/job-offer/2028-summer-analyst-internship-global-banking-asset-finance-securitization');
  assert.equal(rows[0].location, 'New York, New York, United States');
  assert.ok(rows.every((r) => /Internship/.test(r.title)));
});

test('parseListPage(): malformed cards skipped; comma totals parsed', () => {
  const html = `<h2><span class="nb-total spanGreen">2,844</span></h2><ul class="results rh-results">
    <article class="card-custom card-offer"><a href="https://evil.example/en/careers/job-offer/x"><h3>Foreign</h3></a></article>
    <article class="card-custom card-offer"><a href="/en/careers/job-offer/no-title"><h3>  </h3></a></article>
    <article class="card-custom card-offer"><div>no link</div></article>
    <article class="card-custom card-offer"><a href="/en/careers/other/x"><h3>Wrong path</h3></a></article>
    <article class="card-custom card-offer"><a href="/en/careers/job-offer/ok-1"><h3 class="title-4">R&amp;D Intern</h3><div class="offer-location">Paris</div></a></article>
  </ul>`;
  const { total, rows, rawCount } = parseListPage(html);
  assert.equal(total, 2844);
  assert.equal(rawCount, 5);
  assert.deepEqual(rows.map((r) => r.title), ['R&D Intern']);
  assert.equal(rows[0].location, 'Paris');
});

test('parseListPage(): block/redesigned page → descriptive throw', () => {
  assert.throws(() => parseListPage('<html><head><title>Access Denied</title></head><body>x</body></html>'), /unexpected list page .*title: Access Denied/);
  assert.throws(() => parseListPage(null), /not text/);
});

test('fetch(): walks exactly ceil(total/10) pages, redirect:error + browser UA on every request', async () => {
  const ctx = makeCtx([page(10, 1, 25), page(10, 11, 25), page(5, 21, 25)]);
  const jobs = await bnp.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 25);
  assert.deepEqual(ctx.calls.map((c) => c.url), [US_URL, `${US_URL}?page=2`, `${US_URL}?page=3`]);
  for (const c of ctx.calls) {
    assert.equal(c.opts.redirect, 'error');
    assert.match(c.opts.headers['user-agent'], /Mozilla/);
  }
  assert.deepEqual(Object.keys(jobs[0]).sort(), ['company', 'location', 'title', 'url']);
  assert.equal(jobs[0].company, 'BNP Paribas');
});

test('fetch(): host/path guard throws before any request', async () => {
  for (const careers_url of ['https://evil.example/en/careers/all-job-offers', 'http://group.bnpparibas/en/careers/all-job-offers', 'https://group.bnpparibas/en/news', 'nope']) {
    const ctx = makeCtx([FIXTURE]);
    await assert.rejects(() => bnp.fetch({ name: 'X', careers_url }, ctx));
    assert.equal(ctx.calls.length, 0, careers_url);
  }
});

test('fetch(): zero offers → []; counter>0 but no cards / block page → throw', async () => {
  assert.deepEqual(await bnp.fetch(ENTRY, makeCtx([page(0, 1, 0)])), []);
  await assert.rejects(() => bnp.fetch(ENTRY, makeCtx([page(0, 1, 12)])), /reports 12 offers but has no offer cards/);
  await assert.rejects(() => bnp.fetch(ENTRY, makeCtx(['<html><title>Access Denied</title></html>'])), /unexpected list page/);
  await assert.rejects(() => bnp.fetch(ENTRY, makeCtx(['<ul class="results rh-results"></ul>'])), /result counter missing/);
});

test('fetch(): DEFAULT_MAX_PAGES / max_pages caps the walk and warns', async () => {
  const errs = [];
  const orig = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    const bodies = Array.from({ length: 30 }, (_, p) => page(10, p * 10 + 1, 100000));
    const ctx = makeCtx(bodies);
    const jobs = await bnp.fetch(ENTRY, ctx);
    assert.equal(ctx.calls.length, 30);
    assert.equal(jobs.length, 300);
    const ctx2 = makeCtx(bodies);
    await bnp.fetch({ ...ENTRY, max_pages: 2 }, ctx2);
    assert.equal(ctx2.calls.length, 2);
  } finally {
    console.error = orig;
  }
  assert.ok(errs.some((m) => /truncated at 300 of 100000.*raise max_pages/.test(m)));
});

test('fetch(): page-2 failure keeps page 1 and does not claim truncation', async () => {
  const errs = [];
  const orig = console.error;
  console.error = (m) => errs.push(String(m));
  const fail = Object.assign(new Error('HTTP 403'), { status: 403 });
  try {
    const jobs = await bnp.fetch(ENTRY, makeCtx([page(10, 1, 25), fail]));
    assert.equal(jobs.length, 10);
  } finally {
    console.error = orig;
  }
  assert.ok(errs.some((m) => /page 2 failed/.test(m)));
  assert.ok(!errs.some((m) => /raise max_pages/.test(m)));
});

test('fetch(): probe (ctx.maxPages=1) → one request; rejection propagates unwrapped', async () => {
  const ctx = makeCtx([page(10, 1, 38)], { maxPages: 1 });
  const jobs = await bnp.fetch(ENTRY, ctx);
  assert.equal(ctx.calls.length, 1);
  assert.equal(jobs.length, 10);
  class ProbePageBudgetReached extends Error {}
  const err = new ProbePageBudgetReached('budget');
  await assert.rejects(() => bnp.fetch(ENTRY, makeCtx([err, err, err], { maxPages: 1 })), (e) => e === err);
});

test('regression: a later page gets the same counter/card check; an error page warns, never ends silently', async () => {
  // review 2 #6: page 2 = error div inside the result list ended the walk with no warning
  const errPage = '<ul class="results rh-results"><div class="error">Search temporarily unavailable</div></ul>';
  for (const [p2, why] of [[errPage, /no result counter and 0 offer cards/], [page(0, 11, 25), /counter 25 and 0 offer cards/], ['<html><title>Access Denied</title></html>', /unexpected list page/]]) {
    const errs = [];
    const orig = console.error;
    console.error = (m) => errs.push(String(m));
    let jobs;
    const ctx = makeCtx([page(10, 1, 25), p2]);
    try {
      jobs = await bnp.fetch(ENTRY, ctx);
    } finally {
      console.error = orig;
    }
    assert.equal(jobs.length, 10);
    assert.equal(ctx.calls.length, 2);
    assert.ok(errs.some((m) => /page 2 unreadable/.test(m) && why.test(m) && /keeping 10 postings/.test(m)), errs.join('|'));
    assert.ok(!errs.some((m) => /raise max_pages/.test(m)));
  }
  // while probing, a bad later page throws instead
  await assert.rejects(() => bnp.fetch(ENTRY, makeCtx([page(10, 1, 25), errPage], { maxPages: 2 })), /page 2 has no result counter/);
});
