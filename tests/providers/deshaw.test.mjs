// tests/providers/deshaw.test.mjs — D. E. Shaw careers (Next.js __NEXT_DATA__).
//
// The fixture is a trimmed live page (2026-11-07): 3 regular jobs, 1
// internship, 1 internal (inactive) job. No network — ctx is stubbed.
//
// Run:  node --test tests/providers/deshaw.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/deshaw.mjs')).href);
const ds = mod.default;
const { extractNextData, parseDeshawJobs } = mod;

const FIXTURE = readFileSync(join(ROOT, 'tests/fixtures/deshaw-careers.html'), 'utf8');
const ENTRY = { name: 'D. E. Shaw', careers_url: 'https://www.deshaw.com/careers' };

/** Wrap pageProps into a careers page body. */
function page(pageProps) {
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps } })}</script></body></html>`;
}

function makeCtx(bodies) {
  const calls = [];
  let i = 0;
  return {
    calls,
    sleep: async () => {},
    fetchText: async (url, opts) => {
      calls.push({ url, opts });
      const b = bodies[i++];
      if (b instanceof Error) throw b;
      return b;
    },
  };
}

test('id', () => {
  assert.equal(ds.id, 'deshaw');
});

test('detect(): claims only https www.deshaw.com/careers', () => {
  assert.deepEqual(ds.detect(ENTRY), { url: 'https://www.deshaw.com/careers' });
  assert.deepEqual(ds.detect({ careers_url: 'https://www.deshaw.com/careers/choose-your-path' }), { url: 'https://www.deshaw.com/careers' });
  for (const bad of ['http://www.deshaw.com/careers', 'https://evil.example/careers', 'https://www.deshaw.com.evil.example/careers', 'https://www.deshaw.com/about', 'nope', '']) {
    assert.equal(ds.detect({ careers_url: bad }), null, bad);
  }
  assert.equal(ds.detect({}), null);
  assert.equal(ds.detect({ careers_url: 7 }), null);
  assert.equal(ds.detect(null), null);
});

test('parseDeshawJobs(): real fixture — active jobs + internships, internal skipped, US offices mapped', () => {
  const rows = parseDeshawJobs(extractNextData(FIXTURE));
  assert.equal(rows.length, 4);
  assert.ok(!rows.some((r) => /FinOp/.test(r.title)), 'inactive internal job skipped');
  const sg = rows.find((r) => /Receptionist/.test(r.title));
  assert.equal(sg.url, 'https://www.deshaw.com/careers/receptionist-singapore-6012');
  assert.equal(sg.location, 'Singapore');
  const intern = rows.find((r) => /Quantitative Analyst Intern/.test(r.title));
  assert.equal(intern.location, 'New York, NY, US');
  assert.match(intern.url, /^https:\/\/www\.deshaw\.com\/careers\/quantitative-analyst-intern-new-york-summer-2027-\d+$/);
});

test('parseDeshawJobs(): malformed records skipped, entities decoded, duplicates collapsed', () => {
  const ok = { data: { id: 1, displayName: 'R&amp;D Analyst', jobUrl: 'RD-Analyst-1', jobMetadata: { jobLocations: [{ name: 'Denver', abbreviation: 'DEN' }] } } };
  const rows = parseDeshawJobs({
    props: {
      pageProps: {
        regularJobs: [
          null,
          { data: null },
          { data: { id: 2, displayName: 7, jobUrl: 'x-2' } },
          { data: { id: 3, displayName: 'Bad slug', jobUrl: '../../evil' } },
          { data: { id: 4, displayName: 'No slug' } },
          { data: { id: 5, displayName: 'Lone surrogate \uD800', jobUrl: 'bad-\uD800' } },
          ok,
          ok,
        ],
        internships: [],
      },
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'R&D Analyst');
  assert.equal(rows[0].url, 'https://www.deshaw.com/careers/rd-analyst-1');
  assert.equal(rows[0].location, 'Denver, CO, US');
});

test('parseDeshawJobs(): genuine zero → []; error flag / missing lists / no pageProps → throw', () => {
  assert.deepEqual(parseDeshawJobs({ props: { pageProps: { regularJobs: [], internships: [] } } }), []);
  assert.throws(() => parseDeshawJobs({ props: { pageProps: { regularJobs: [], internships: [], jobsFetchingError: true } } }), /jobsFetchingError/);
  assert.throws(() => parseDeshawJobs({ props: { pageProps: { regularJobs: {}, internships: [] } } }), /regularJobs is object/);
  assert.throws(() => parseDeshawJobs({ props: { pageProps: { other: 1 } } }), /regularJobs is missing; keys: other/);
  assert.throws(() => parseDeshawJobs({ props: {} }), /no props\.pageProps/);
  assert.throws(() => parseDeshawJobs(null), /no props\.pageProps/);
});

test('extractNextData(): missing script or bad JSON → throw', () => {
  assert.throws(() => extractNextData('<html>Access Denied</html>'), /__NEXT_DATA__ not found/);
  assert.throws(() => extractNextData('<script id="__NEXT_DATA__" type="application/json">{nope</script>'), /not valid JSON/);
  assert.throws(() => extractNextData(undefined), /not text/);
});

test('fetch(): one GET of the fixed page, redirect:error, normalized rows', async () => {
  const ctx = makeCtx([FIXTURE]);
  const jobs = await ds.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 4);
  assert.deepEqual(Object.keys(jobs[0]).sort(), ['company', 'location', 'title', 'url']);
  assert.equal(jobs[0].company, 'D. E. Shaw');
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].url, 'https://www.deshaw.com/careers');
  assert.equal(ctx.calls[0].opts.redirect, 'error');
});

test('fetch(): host guard throws before any request', async () => {
  for (const careers_url of ['https://evil.example/careers', 'http://www.deshaw.com/careers', 'nope', undefined]) {
    const ctx = makeCtx([FIXTURE]);
    await assert.rejects(() => ds.fetch({ name: 'X', careers_url }, ctx));
    assert.equal(ctx.calls.length, 0, String(careers_url));
  }
});

test('fetch(): empty board → []; block page / changed shape → throw', async () => {
  assert.deepEqual(await ds.fetch(ENTRY, makeCtx([page({ regularJobs: [], internships: [] })])), []);
  await assert.rejects(() => ds.fetch(ENTRY, makeCtx(['<html>Access Denied</html>'])), /__NEXT_DATA__ not found/);
  await assert.rejects(() => ds.fetch(ENTRY, makeCtx([page({ jobs: [] })])), /unexpected pageProps shape/);
});

test('fetch(): transport rejection propagates unwrapped (probe budget identity)', async () => {
  class ProbePageBudgetReached extends Error {}
  const err = new ProbePageBudgetReached('budget');
  await assert.rejects(() => ds.fetch(ENTRY, { ...makeCtx([err, err, err]), maxPages: 1 }), (e) => e === err);
});
