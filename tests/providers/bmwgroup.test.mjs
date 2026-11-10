// tests/providers/bmwgroup.test.mjs — BMW Group job finder (AEM jobfinder fragment).
//
// Fixtures are trimmed live captures (2026-11-07) of the US country page and
// its jobfinder_table fragment; no network is used — ctx is stubbed.
//
// Run:  node --test tests/providers/bmwgroup.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/bmwgroup.mjs')).href);
const bmw = mod.default;
const { resolveConfig, parseJobfinderPage, prefilterToQuery, parseFragment } = mod;

const PAGE = readFileSync(join(ROOT, 'tests/fixtures/bmwgroup-jobs-page.html'), 'utf8');
const FRAG = readFileSync(join(ROOT, 'tests/fixtures/bmwgroup-fragment.html'), 'utf8');
const URL_US = 'https://www.bmwgroup.jobs/us/en/jobs.html';
const ENTRY = { name: 'Acme', careers_url: URL_US };

/** A synthetic fragment with `n` rows starting at id `start`, reporting `total`. */
function frag(n, start, total) {
  let rows = '';
  for (let i = 0; i < n; i++) {
    const id = start + i;
    rows += `<div class="grp-jobfinder__wrapper" data-job-id="${id}"><a class="grp-popup-link-js grp-jobfinder__link-jobdescription" href="/us/en/jobfinder/job-description-copy.${id}.html">`
      + `<div class="grp-jobfinder-cell-refno" data-job-title="Job ${id}" data-job-location="Town, ST" data-posting-date="20261101">${id}</div>`
      + `<div class="grp-jobfinder-cell-job-title-group__title">Job ${id}</div></a></div>`;
  }
  return `<div class="grp-jobfinder__table" data-counter="${total}">${rows}</div>`;
}

/** ctx whose fetchText serves the page first, then the given fragment bodies (or Errors). */
function makeCtx(fragments, extra = {}) {
  const calls = [];
  let i = 0;
  return {
    calls,
    sleep: async () => {},
    fetchText: async (url, opts) => {
      calls.push({ url, opts });
      if (url.endsWith('/jobs.html') || url.includes('/jobs.html#')) return PAGE;
      const body = fragments[i++];
      if (body instanceof Error) throw body;
      return body ?? '';
    },
    ...extra,
  };
}

test('id', () => {
  assert.equal(bmw.id, 'bmwgroup');
});

test('detect(): claims only https www.bmwgroup.jobs country pages', () => {
  assert.deepEqual(bmw.detect({ careers_url: URL_US }), { url: URL_US });
  assert.ok(bmw.detect({ careers_url: 'https://www.bmwgroup.jobs/de/de/jobs.html' }));
  for (const bad of [
    'http://www.bmwgroup.jobs/us/en/jobs.html',
    'https://evil.example/us/en/jobs.html',
    'https://www.bmwgroup.jobs.evil.example/us/en/jobs.html',
    'https://www.bmwgroup.jobs/',
    'not a url',
    '',
  ]) assert.equal(bmw.detect({ careers_url: bad }), null, bad);
  assert.equal(bmw.detect({}), null);
  assert.equal(bmw.detect({ careers_url: 42 }), null);
  assert.equal(bmw.detect(null), null);
});

test('resolveConfig(): country/lang from the path, hash filter override', () => {
  const c = resolveConfig(ENTRY);
  assert.equal(c.pageUrl, URL_US);
  assert.equal(c.country, 'us');
  assert.equal(c.lang, 'en');
  assert.equal(resolveConfig({ careers_url: 'https://www.bmwgroup.jobs/de/de/' }).pageUrl, 'https://www.bmwgroup.jobs/de/de/jobs.html');
  assert.equal(resolveConfig({ careers_url: `${URL_US}#location=US/Mountain%20View` }).hashFilter, 'location=US/Mountain View');
  assert.equal(resolveConfig({ careers_url: `${URL_US}#top` }).hashFilter, '');
});

test('parseJobfinderPage() + prefilterToQuery(): component path and US scope', () => {
  const { componentPath, prefilter } = parseJobfinderPage(PAGE);
  assert.equal(componentPath, '/_jcr_content/main/layoutcontainer_5337/jobfinder30.jobfinder_table.content.html');
  assert.equal(prefilter, 'location=US');
  assert.deepEqual(prefilterToQuery(prefilter), { filterSearch: 'location_US', textSearch: '' });
  assert.deepEqual(prefilterToQuery('location=US,DE&&jobType=Internship&&fulltext=data'), {
    filterSearch: 'location_US,location_DE,jobType_Internship',
    textSearch: 'data',
  });
  assert.equal(parseJobfinderPage('<div data-jobfinder-path="https://evil.example/x.html">').componentPath, null);
});

test('parseFragment(): real fixture rows, single-decoded titles, dates', () => {
  const { rows, total, rawCount, hasTable } = parseFragment(FRAG, 'https://www.bmwgroup.jobs', { country: 'us', lang: 'en' });
  assert.equal(hasTable, true);
  assert.equal(total, 24);
  assert.equal(rawCount, 3);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].title, 'Intern, Power Electronics & GaN Technology - Spring 2027');
  assert.equal(rows[0].url, 'https://www.bmwgroup.jobs/us/en/jobfinder/job-description-copy.199972.html');
  assert.equal(rows[0].location, 'Mountain View, CA');
  assert.equal(rows[0].postedAt, Date.UTC(2026, 10, 6));
});

test('parseFragment(): rows missing a title are dropped; data-job-title fallback decodes twice', () => {
  const html = '<div class="grp-jobfinder__table" data-counter="2">'
    + '<div class="grp-jobfinder__wrapper" data-job-id="1"><a class="grp-jobfinder__link-jobdescription" href="/us/en/jobfinder/job-description-copy.1.html"><div data-job-title="R&amp;amp;D Lead" data-posting-date="2026xx01"></div></a></div>'
    + '<div class="grp-jobfinder__wrapper" data-job-id="2"><a class="grp-jobfinder__link-jobdescription" href="/us/en/jobfinder/job-description-copy.2.html"></a></div>'
    + '</div>';
  const { rows } = parseFragment(html, 'https://www.bmwgroup.jobs', { country: 'us', lang: 'en' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'R&D Lead');
  assert.equal(rows[0].postedAt, undefined);
});

test('fetch(): page then fragment, redirect:error on every request, normalized rows', async () => {
  const ctx = makeCtx([FRAG]);
  const jobs = await bmw.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 3); // rawCount 3 < blockCount → done
  assert.deepEqual(Object.keys(jobs[0]).sort(), ['company', 'location', 'postedAt', 'title', 'url']);
  assert.equal(jobs[0].company, 'Acme');
  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.calls[0].url, URL_US);
  const fragUrl = new URL(ctx.calls[1].url);
  assert.equal(fragUrl.origin + fragUrl.pathname, 'https://www.bmwgroup.jobs/us/en/jobs/_jcr_content/main/layoutcontainer_5337/jobfinder30.jobfinder_table.content.html');
  assert.equal(fragUrl.searchParams.get('filterSearch'), 'location_US');
  assert.equal(fragUrl.searchParams.get('rowIndex'), '0');
  assert.equal(fragUrl.searchParams.get('blockCount'), '100');
  for (const c of ctx.calls) assert.equal(c.opts.redirect, 'error');
});

test('fetch(): hash filter on careers_url overrides the page prefilter', async () => {
  const ctx = makeCtx([FRAG]);
  await bmw.fetch({ name: 'Acme', careers_url: `${URL_US}#location=US/Mountain%20View` }, ctx);
  assert.equal(new URL(ctx.calls[1].url).searchParams.get('filterSearch'), 'location_US/Mountain View');
});

test('fetch(): host guard throws before any request', async () => {
  for (const careers_url of ['https://evil.example/us/en/jobs.html', 'http://www.bmwgroup.jobs/us/en/jobs.html', 'nope']) {
    const ctx = makeCtx([FRAG]);
    await assert.rejects(() => bmw.fetch({ name: 'Acme', careers_url }, ctx));
    assert.equal(ctx.calls.length, 0, careers_url);
  }
});

test('fetch(): empty fragment → []; table with zero rows → []; missing table → throw', async () => {
  assert.deepEqual(await bmw.fetch(ENTRY, makeCtx([''])), []);
  assert.deepEqual(await bmw.fetch(ENTRY, makeCtx(['<div class="grp-jobfinder__table" data-counter="0"></div>'])), []);
  await assert.rejects(() => bmw.fetch(ENTRY, makeCtx(['<html><body>maintenance</body></html>'])), /grp-jobfinder__table/);
});

test('fetch(): page without data-jobfinder-path → descriptive throw', async () => {
  const ctx = makeCtx([]);
  ctx.fetchText = async () => '<html>redesigned</html>';
  await assert.rejects(() => bmw.fetch(ENTRY, ctx), /data-jobfinder-path/);
});

test('fetch(): paginates by rowIndex and stops at the server total', async () => {
  const ctx = makeCtx([frag(100, 1, 250), frag(100, 101, 250), frag(50, 201, 250)]);
  const jobs = await bmw.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 250);
  const rowIdx = ctx.calls.slice(1).map((c) => new URL(c.url).searchParams.get('rowIndex'));
  assert.deepEqual(rowIdx, ['0', '100', '200']);
});

test('fetch(): DEFAULT_MAX_PAGES / max_pages ceiling stops a source that keeps reporting more, and warns', async () => {
  const pages = Array.from({ length: 50 }, (_, p) => frag(100, p * 100 + 1, 999999));
  const warnings = [];
  const real = console.error;
  console.error = (m) => warnings.push(String(m));
  try {
    const ctx = makeCtx(pages);
    const jobs = await bmw.fetch(ENTRY, ctx);
    assert.equal(ctx.calls.length - 1, 20); // DEFAULT_MAX_PAGES
    assert.equal(jobs.length, 2000);
    const ctx2 = makeCtx(pages);
    await bmw.fetch({ ...ENTRY, max_pages: 2 }, ctx2);
    assert.equal(ctx2.calls.length - 1, 2);
    assert.ok(warnings.some((w) => /raise max_pages/.test(w)));
  } finally {
    console.error = real;
  }
});

test('fetch(): ctx.maxPages=1 → exactly one list request, no truncation warning', async () => {
  const warnings = [];
  const real = console.error;
  console.error = (m) => warnings.push(String(m));
  try {
    const ctx = makeCtx([frag(100, 1, 500), frag(100, 101, 500)], { maxPages: 1 });
    const jobs = await bmw.fetch(ENTRY, ctx);
    assert.equal(ctx.calls.length - 1, 1);
    assert.equal(jobs.length, 100);
    assert.equal(warnings.filter((w) => /raise max_pages/.test(w)).length, 0);
  } finally {
    console.error = real;
  }
});

test('fetch(): a probe-time rejection propagates unwrapped', async () => {
  class ProbePageBudgetReached extends Error {}
  const err = new ProbePageBudgetReached('budget');
  const ctx = makeCtx([err, err, err], { maxPages: 1 }); // the real probe keeps throwing on retries
  await assert.rejects(() => bmw.fetch(ENTRY, ctx), (e) => e === err);
});

test('fetch(): page-2 5xx that retry cannot clear keeps page 1 and does not claim truncation', async () => {
  const boom = Object.assign(new Error('HTTP 503'), { status: 503 });
  const warnings = [];
  const real = console.error;
  console.error = (m) => warnings.push(String(m));
  try {
    const ctx = makeCtx([frag(100, 1, 300), boom, boom, boom]);
    const jobs = await bmw.fetch(ENTRY, ctx);
    assert.equal(jobs.length, 100);
    assert.equal(ctx.calls.length - 1, 4); // page 1 + 3 attempts on page 2 (default 2 retries)
    assert.ok(warnings.some((w) => /page 2 failed/.test(w)));
    assert.equal(warnings.filter((w) => /raise max_pages/.test(w)).length, 0);
  } finally {
    console.error = real;
  }
});

test('fetch(): a first-page failure throws (unreachable, not empty)', async () => {
  const boom = Object.assign(new Error('HTTP 404'), { status: 404 });
  await assert.rejects(() => bmw.fetch(ENTRY, makeCtx([boom])), /404/);
});
