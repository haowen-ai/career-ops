// tests/providers/google.test.mjs — Google Careers search page (server-rendered
// ds:1 data island on www.google.com/about/careers/applications/jobs/results/).
//
// The fixture is a trimmed live page (2026-11-08): two real rows, three
// malformed rows, total=5, pageSize=20. No network — ctx is stubbed.
//
// Run:  node --test tests/providers/google.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/google.mjs')).href);
const gg = mod.default;
const { resolveConfig, buildPageUrl, extractResultsIsland, parseResultsPage, slugify } = mod;

const FIXTURE = readFileSync(join(ROOT, 'tests/fixtures/google-careers-results.html'), 'utf8');
const BASE = 'https://www.google.com/about/careers/applications/jobs/results/';
const ENTRY = { name: 'Google', careers_url: `${BASE}?location=United%20States&target_level=INTERN_AND_APPRENTICE` };

/** Build a search page whose ds:1 island holds `data`. */
function page(data) {
  return `<html><script>AF_initDataCallback({key: 'ds:1', hash: '2', data:${JSON.stringify(data)}, sideChannel: {}});</script></html>`;
}
/** A well-formed row. */
function row(id, title = `Job ${id}`) {
  return [String(id), title, null, null, null, 'x', null, 'Google', 'en-US', [['New York, NY, USA', null, 'New York', null, 'NY', 'US']], null, [4], [1790000000, 0]];
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

test('id and detect(): claims only the pinned careers search URL', () => {
  assert.equal(gg.id, 'google');
  assert.ok(gg.detect(ENTRY));
  assert.equal(gg.detect({ careers_url: 'https://careers.google.com/jobs/results/' }), null);
  assert.equal(gg.detect({ careers_url: 'https://www.google.com/search?q=jobs' }), null);
  assert.equal(gg.detect({ careers_url: 'https://boards.greenhouse.io/acme' }), null);
});

test('resolveConfig(): host/path allowlist and parameter allowlist enforced', () => {
  assert.deepEqual(resolveConfig(ENTRY).params, [['location', 'United States'], ['target_level', 'INTERN_AND_APPRENTICE']]);
  // page is owned by the provider and dropped
  assert.deepEqual(resolveConfig({ careers_url: `${BASE}?page=7&q=intern` }).params, [['q', 'intern']]);
  for (const bad of [
    'http://www.google.com/about/careers/applications/jobs/results/',
    'https://www.google.com.evil.example/about/careers/applications/jobs/results/',
    'https://google.com/about/careers/applications/jobs/results/',
    'https://www.google.com:8443/about/careers/applications/jobs/results/',
    'https://www.google.com/about/careers/applications/jobs/results/123-x',
    `${BASE}?redirect=https://evil.example`,
    'not a url',
  ]) {
    assert.throws(() => resolveConfig({ careers_url: bad }), Error, bad);
  }
  assert.throws(() => resolveConfig({}), /careers_url is required/);
});

test('buildPageUrl(): keeps repeated filters, page only from 2', () => {
  const cfg = resolveConfig({ careers_url: `${BASE}?location=United%20States&target_level=EARLY&target_level=INTERN_AND_APPRENTICE` });
  const p1 = new URL(buildPageUrl(cfg, 1));
  assert.equal(p1.searchParams.get('page'), null);
  assert.deepEqual(p1.searchParams.getAll('target_level'), ['EARLY', 'INTERN_AND_APPRENTICE']);
  assert.equal(new URL(buildPageUrl(cfg, 3)).searchParams.get('page'), '3');
});

test('extractResultsIsland() + parseResultsPage(): real rows mapped, malformed rows skipped', () => {
  const data = extractResultsIsland(FIXTURE);
  const res = parseResultsPage(data, 'Google');
  assert.equal(res.rawCount, 5);
  assert.equal(res.skipped, 3);
  assert.equal(res.total, 5);
  assert.equal(res.pageSize, 20);
  assert.equal(res.jobs.length, 2);
  const [a, b] = res.jobs;
  assert.equal(a.title, 'Software Engineering Intern, PhD, Summer 2027');
  assert.equal(a.url, `${BASE}91436104816698054-software-engineering-intern-phd-summer-2027`);
  assert.equal(a.location, 'Mountain View, CA, USA · Atlanta, GA, USA');
  assert.equal(a.postedAt, 1787559294000);
  assert.equal(a.company, 'Google');
  assert.equal(b.title, 'MBA Intern, Summer 2027');
  assert.ok(b.url.startsWith(`${BASE}121103710599160518-`));
});

test('extractResultsIsland(): the string scanner ignores brackets inside strings', () => {
  const data = extractResultsIsland(page([[row(11111, 'Title with ] and [ and "quotes"')], null, 1, 20]));
  assert.equal(data[0][0][1], 'Title with ] and [ and "quotes"');
});

test('unknown or broken shapes throw instead of returning []', () => {
  assert.throws(() => extractResultsIsland(''), /empty search page/);
  assert.throws(() => extractResultsIsland('<html>Sorry, unusual traffic</html>'), /no ds:1 results island/);
  assert.throws(() => extractResultsIsland("AF_initDataCallback({key: 'ds:1', hash: '2', data:[[1,2"), /truncated/);
  assert.throws(() => extractResultsIsland("AF_initDataCallback({key: 'ds:1', hash: '2', data:{\"a\":1}"), /not an array/);
  assert.throws(() => parseResultsPage({ jobs: [] }, 'Google'), /unexpected shape/);
  assert.throws(() => parseResultsPage([[], null, 'many', 20], 'Google'), /total is not a number/);
  assert.throws(() => parseResultsPage([[], null, 10, 0], 'Google'), /page size/);
  assert.throws(() => parseResultsPage([{}, null, 10, 20], 'Google'), /neither an array nor null/);
  assert.throws(() => parseResultsPage([[['x'], ['y']], null, 2, 20], 'Google'), /none parsed/);
  // past the end: null job list with a numeric total is an honest empty page
  assert.deepEqual(parseResultsPage([null, null, 40, 20], 'Google').jobs, []);
});

test('slugify()', () => {
  assert.equal(slugify('Research Intern, PhD, Summer 2027'), 'research-intern-phd-summer-2027');
  assert.equal(slugify('  C++ / Rust  '), 'c-rust');
});

test('fetch(): paginates by raw row count until total, pinned host, redirect refused', async () => {
  const p1 = page([[...Array.from({ length: 19 }, (_, i) => row(100000 + i)), ['bad-row']], null, 45, 20]);
  const p2 = page([Array.from({ length: 20 }, (_, i) => row(200000 + i)), null, 45, 20]);
  const p3 = page([Array.from({ length: 5 }, (_, i) => row(300000 + i)), null, 45, 20]);
  const ctx = makeCtx([p1, p2, p3]);
  const jobs = await gg.fetch(ENTRY, ctx);
  assert.equal(ctx.calls.length, 3);
  assert.equal(jobs.length, 44); // one malformed row skipped, pagination not stopped by it
  for (const c of ctx.calls) {
    const u = new URL(c.url);
    assert.equal(u.hostname, 'www.google.com');
    assert.equal(c.opts.redirect, 'error');
  }
  assert.equal(new URL(ctx.calls[2].url).searchParams.get('page'), '3');
});

test('fetch(): a short page before total does not end the loop; final shortfall is reported', async () => {
  const pages = [
    page([Array.from({ length: 20 }, (_, i) => row(400000 + i)), null, 60, 20]),
    page([Array.from({ length: 12 }, (_, i) => row(500000 + i)), null, 60, 20]), // short, mid-board
    page([Array.from({ length: 20 }, (_, i) => row(600000 + i)), null, 60, 20]),
    page([[], null, 60, 20]),
  ];
  const ctx = makeCtx(pages);
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const jobs = await gg.fetch(ENTRY, ctx);
    assert.equal(jobs.length, 52);
    assert.equal(ctx.calls.length, 4);
  } finally {
    console.error = orig;
  }
  assert.ok(errs.some((e) => /truncated/.test(e) && /52 of 60/.test(e)), errs.join('\n'));
});

test('fetch(): bounded by max_pages and ctx.maxPages, with a truncation warning', async () => {
  const ctx = makeCtx(() => page([Array.from({ length: 20 }, (_, i) => row(700000 + Math.floor(Math.random() * 1e9) + i)), null, 100000, 20]));
  const orig = console.error;
  const errs = [];
  console.error = (...a) => errs.push(a.join(' '));
  try {
    await gg.fetch({ ...ENTRY, max_pages: 3 }, ctx);
    assert.equal(ctx.calls.length, 3);
    const probe = makeCtx(() => page([[row(1234567)], null, 1, 20]));
    await gg.fetch(ENTRY, { ...probe, maxPages: 1 });
    assert.equal(probe.calls.length, 1);
  } finally {
    console.error = orig;
  }
  assert.ok(errs.some((e) => /max_pages=3/.test(e)));
});

test('fetch(): guard runs before any request; transport errors propagate', async () => {
  const ctx = makeCtx([]);
  await assert.rejects(gg.fetch({ name: 'Evil', careers_url: 'https://evil.example/about/careers/applications/jobs/results/' }, ctx), /host not allowed/);
  assert.equal(ctx.calls.length, 0);
  const e = new Error('HTTP 404'); e.status = 404;
  await assert.rejects(gg.fetch(ENTRY, makeCtx([e])), /HTTP 404/);
  await assert.rejects(gg.fetch(ENTRY, makeCtx(['<html>blocked</html>'])), /no ds:1/);
});
