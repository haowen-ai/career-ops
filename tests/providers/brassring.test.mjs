// tests/providers/brassring.test.mjs — IBM/Kenexa BrassRing TGnewUI provider.
//
// Fixtures are trimmed live captures (2026-11-07): a cut-down home page
// (token input + the searchResults config input) and a 3-row MatchedJobs
// response. No network is used — ctx is stubbed.
//
// Run:  node --test tests/providers/brassring.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/brassring.mjs')).href);
const br = mod.default;
const { resolveConfig, parseHomePage, pickLocationFields, parseJobsResponse, cookieHeaderFrom, toEpochMs } = mod;

const HOME = readFileSync(join(ROOT, 'tests/fixtures/brassring-home.html'), 'utf8');
const JOBS = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/brassring-jobs.json'), 'utf8'));
const URL_OK = 'https://sjobs.brassring.com/TGnewUI/Search/Home/Home?partnerid=26350&siteid=6930';
const ENTRY = { name: 'Acme', careers_url: URL_OK };
const CFG = resolveConfig(ENTRY);

/** Synthetic page of `n` rows starting at reqid `start`, reporting `total`. */
function page(n, start, total) {
  return {
    JobsCount: total,
    Jobs: {
      Job: Array.from({ length: n }, (_, i) => ({
        Questions: [
          { QuestionName: 'reqid', Value: String(start + i) },
          { QuestionName: 'jobtitle', Value: `Job ${start + i}` },
          { QuestionName: 'lastupdated', Value: '01-Nov-2026' },
        ],
        Link: `https://sjobs.brassring.com/TGnewUI/Search/home/HomeWithPreLoad?partnerid=26350&siteid=6930&PageType=JobDetails&jobid=${start + i}`,
      })),
    },
  };
}

function makeCtx(bodies, extra = {}) {
  const calls = [];
  const homeCalls = [];
  let i = 0;
  return {
    calls,
    homeCalls,
    sleep: async () => {},
    fetchResponse: async (url, opts) => {
      homeCalls.push({ url, opts });
      return new Response(HOME, { status: 200, headers: [['set-cookie', 'tg_rft_mvc=abc; path=/; HttpOnly'], ['set-cookie', 'tg_session=s1; path=/']] });
    },
    fetchJson: async (url, opts) => {
      calls.push({ url, opts, body: JSON.parse(opts.body) });
      const b = bodies[i++];
      if (b instanceof Error) throw b;
      return b === undefined ? { JobsCount: 0, Jobs: { Job: [] } } : b;
    },
    ...extra,
  };
}

async function captureWarnings(fn) {
  const warnings = [];
  const real = console.error;
  console.error = (m) => warnings.push(String(m));
  try {
    await fn();
  } finally {
    console.error = real;
  }
  return warnings;
}

test('id', () => {
  assert.equal(br.id, 'brassring');
});

test('detect(): claims https TGnewUI URLs on known BrassRing hosts with partnerid+siteid', () => {
  assert.deepEqual(br.detect({ careers_url: URL_OK }), { url: URL_OK });
  const ubs = 'https://jobs.ubs.com/TGnewUI/Search/home/HomeWithPreLoad?partnerid=25008&siteid=5131';
  assert.deepEqual(br.detect({ careers_url: ubs }), { url: ubs });
  for (const bad of [
    'http://sjobs.brassring.com/TGnewUI/Search/Home/Home?partnerid=1&siteid=2',
    'https://evil.example/TGnewUI/Search/Home/Home?partnerid=1&siteid=2',
    'https://sjobs.brassring.com.evil.example/TGnewUI/?partnerid=1&siteid=2',
    'https://sjobs.brassring.com/TGnewUI/Search/Home/Home?partnerid=26235', // no siteid
    'https://sjobs.brassring.com/other?partnerid=1&siteid=2',
    'nope',
    '',
  ]) {
    assert.equal(br.detect({ careers_url: bad }), null, bad);
  }
  assert.equal(br.detect({}), null);
  assert.equal(br.detect({ careers_url: 7 }), null);
  assert.equal(br.detect(null), null);
});

test('resolveConfig(): tenant ids, pinned origin, case-insensitive params', () => {
  const c = resolveConfig({ careers_url: 'https://jobs.ubs.com/TGnewUI/Search/Home/Home?PartnerId=25008&SiteId=5012' });
  assert.equal(c.partnerId, '25008');
  assert.equal(c.siteId, '5012');
  assert.equal(c.homeUrl, 'https://jobs.ubs.com/TGnewUI/Search/Home/Home?partnerid=25008&siteid=5012');
  assert.equal(c.firstPageUrl, 'https://jobs.ubs.com/TgNewUI/Search/Ajax/MatchedJobs');
  assert.throws(() => resolveConfig({ careers_url: 'https://sjobs.brassring.com/TGnewUI/?partnerid=1&siteid=x' }), /numeric siteid/);
  assert.throws(() => resolveConfig({ careers_url: 'https://sjobs.brassring.com/TGnewUI/?siteid=1' }), /numeric partnerid/);
  assert.throws(() => resolveConfig({}), /careers_url is required/);
});

test('parseHomePage(): token + tenant config; missing token throws', () => {
  const h = parseHomePage(HOME);
  assert.equal(h.token, 'tok-ABC_123-xyz');
  assert.deepEqual(h.jobFields.Position3, ['formtext6', 'formtext5', 'location']);
  assert.equal(h.locationSolrFields, 'FORMTEXT5,FORMTEXT6');
  assert.throws(() => parseHomePage('<html><title>Error</title></html>'), /no __RequestVerificationToken/);
  assert.throws(() => parseHomePage(''), /empty home page/);
  // unparsable config is tolerated (defaults), token still read
  const h2 = parseHomePage('<input name="__RequestVerificationToken" type="hidden" value="t" /><input id="searchResults" type="hidden" value="{oops" />');
  assert.equal(h2.token, 't');
  assert.equal(h2.jobFields, null);
});

test('pickLocationFields(): drops non-location facets and id fields; override wins', () => {
  const h = parseHomePage(HOME);
  assert.deepEqual(pickLocationFields(h, JOBS.Facets.Facet, undefined), ['formtext5', 'location']);
  assert.deepEqual(pickLocationFields({ jobFields: { Position3: ['autoreq', 'location'] }, locationSolrFields: '' }, null), ['location']);
  assert.deepEqual(pickLocationFields(h, JOBS.Facets.Facet, ['FormText9']), ['formtext9']);
  assert.deepEqual(pickLocationFields(null, null, null), ['location']);
});

test('cookieHeaderFrom(): name=value pairs only, junk skipped', () => {
  assert.equal(cookieHeaderFrom(['a=1; path=/', 'b=2; HttpOnly', '=x', 'noeq', 5, null]), 'a=1; b=2');
  assert.equal(cookieHeaderFrom(undefined), '');
});

test('toEpochMs(): dd-Mon-yyyy as UTC, NaN-safe', () => {
  assert.equal(toEpochMs('07-Nov-2026'), Date.UTC(2026, 10, 7));
  assert.equal(toEpochMs('07-Foo-2026'), undefined);
  assert.equal(toEpochMs('garbage'), undefined);
  assert.equal(toEpochMs(''), undefined);
  assert.equal(toEpochMs(5), undefined);
});

test('parseJobsResponse(): real fixture rows', () => {
  const { rows, total, rawCount, facets } = parseJobsResponse(JOBS, CFG, ['formtext5', 'location']);
  assert.equal(total, 3);
  assert.equal(rawCount, 3);
  assert.equal(facets.length, 2);
  assert.equal(rows[0].id, '1440057');
  assert.equal(rows[0].title, 'Transportation Manager');
  assert.equal(rows[0].url, 'https://sjobs.brassring.com/TGnewUI/Search/home/HomeWithPreLoad?partnerid=26350&siteid=6930&PageType=JobDetails&jobid=1440057');
  assert.equal(rows[0].location, 'Shafter, California (CA), Performance Food Group Customized Distribution California (0155)');
  assert.equal(rows[0].postedAt, Date.UTC(2026, 10, 7));
});

test('parseJobsResponse(): malformed records skipped, foreign Link rebuilt from reqid, entities decoded', () => {
  const q = (o) => Object.entries(o).map(([QuestionName, Value]) => ({ QuestionName, Value }));
  const { rows, rawCount } = parseJobsResponse({
    JobsCount: 6,
    Jobs: {
      Job: [
        null,
        'x',
        { Questions: 'nope' },
        { Questions: q({ reqid: '1', jobtitle: '' }) }, // no title
        { Questions: [{ QuestionName: 'jobtitle', Value: { bad: 1 } }, { QuestionName: 'reqid', Value: 2 }] }, // wrong types
        { Questions: q({ reqid: '77', jobtitle: 'R&amp;D Intern', location: 'Austin, TX ' }), Link: 'https://evil.example/x' },
        { Questions: q({ reqid: 'abc', jobtitle: 'No usable id or link' }) },
      ],
    },
  }, CFG, ['location']);
  assert.equal(rawCount, 7);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'R&D Intern');
  assert.equal(rows[0].url, 'https://sjobs.brassring.com/TGnewUI/Search/home/HomeWithPreLoad?partnerid=26350&siteid=6930&PageType=JobDetails&jobid=77');
  assert.equal(rows[0].location, 'Austin, TX');
});

test('parseJobsResponse(): genuine empty → empty; envelopes / non-array containers → throw', () => {
  for (const b of [{ JobsCount: 0, Jobs: null }, { JobsCount: 0 }, { JobsCount: 0, Jobs: { Job: null } }, { JobsCount: 0, Jobs: { Job: [] } }]) {
    assert.equal(parseJobsResponse(b, CFG, []).rows.length, 0, JSON.stringify(b));
  }
  assert.throws(() => parseJobsResponse({ Message: 'An error has occurred.' }, CFG, []), /unexpected jobs response shape \(keys: Message\)/);
  assert.throws(() => parseJobsResponse({ JobsCount: 5, Jobs: { Job: { a: 1 } } }, CFG, []), /Jobs.Job is not an array/);
  assert.throws(() => parseJobsResponse({ JobsCount: 5, Jobs: 'x' }, CFG, []), /Jobs.Job is not an array/);
  assert.throws(() => parseJobsResponse({ JobsCount: 12, Jobs: null }, CFG, []), /Jobs container is missing/);
  assert.throws(() => parseJobsResponse([], CFG, []), /unexpected jobs response \(array\)/);
  assert.throws(() => parseJobsResponse('<html>', CFG, []), /unexpected jobs response \(string\)/);
});

test('fetch(): session handshake, normalized rows, redirect:error on every request', async () => {
  const ctx = makeCtx([JOBS]);
  const jobs = await br.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 3);
  assert.deepEqual(Object.keys(jobs[0]).sort(), ['company', 'location', 'postedAt', 'title', 'url']);
  assert.equal(jobs[0].company, 'Acme');
  assert.equal(jobs[0].location, 'Shafter, California (CA), Performance Food Group Customized Distribution California (0155)');
  assert.equal(ctx.homeCalls.length, 1);
  assert.equal(ctx.homeCalls[0].url, 'https://sjobs.brassring.com/TGnewUI/Search/Home/Home?partnerid=26350&siteid=6930');
  assert.equal(ctx.homeCalls[0].opts.redirect, 'error');
  assert.equal(ctx.calls.length, 1);
  const c = ctx.calls[0];
  assert.equal(c.url, 'https://sjobs.brassring.com/TgNewUI/Search/Ajax/MatchedJobs');
  assert.equal(c.opts.redirect, 'error');
  assert.equal(c.opts.method, 'POST');
  assert.equal(c.opts.headers.RFT, 'tok-ABC_123-xyz');
  assert.equal(c.opts.headers.cookie, 'tg_rft_mvc=abc; tg_session=s1');
  assert.equal(c.body.PartnerId, '26350');
  assert.equal(c.body.SiteId, '6930');
  assert.equal(c.body.SortType, 'JobTitle');
});

test('fetch(): host / id guard throws before any request', async () => {
  for (const careers_url of [
    'https://evil.example/TGnewUI/Search/Home/Home?partnerid=1&siteid=2',
    'http://sjobs.brassring.com/TGnewUI/Search/Home/Home?partnerid=1&siteid=2',
    'https://sjobs.brassring.com/TGnewUI/Search/Home/Home?partnerid=1',
    'nope',
  ]) {
    const ctx = makeCtx([JOBS]);
    await assert.rejects(() => br.fetch({ name: 'Acme', careers_url }, ctx));
    assert.equal(ctx.calls.length + ctx.homeCalls.length, 0, careers_url);
  }
});

test('fetch(): home page without token (bad tenant) throws, no search request', async () => {
  const ctx = makeCtx([JOBS], { fetchResponse: async () => new Response('<html><title>Error</title></html>', { status: 200 }) });
  await assert.rejects(() => br.fetch(ENTRY, ctx), /no __RequestVerificationToken/);
  assert.equal(ctx.calls.length, 0);
});

test('fetch(): genuine zero → []; error envelope / non-array → throw', async () => {
  assert.deepEqual(await br.fetch(ENTRY, makeCtx([{ JobsCount: 0, Jobs: null }])), []);
  await assert.rejects(() => br.fetch(ENTRY, makeCtx([{}])), /unexpected jobs response shape \(keys: none\)/);
  await assert.rejects(() => br.fetch(ENTRY, makeCtx([{ Message: 'error' }])), /unexpected jobs response shape/);
  await assert.rejects(() => br.fetch(ENTRY, makeCtx([{ JobsCount: 9, Jobs: { Job: {} } }])), /not an array/);
});

test('fetch(): paginates via ProcessSortAndShowMoreJobs and stops at JobsCount', async () => {
  const ctx = makeCtx([page(50, 1, 120), page(50, 51, 120), page(20, 101, 120)]);
  const jobs = await br.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 120);
  assert.deepEqual(ctx.calls.map((c) => c.url.split('/').pop()), ['MatchedJobs', 'ProcessSortAndShowMoreJobs', 'ProcessSortAndShowMoreJobs']);
  assert.deepEqual(ctx.calls.slice(1).map((c) => c.body.pageNumber), [2, 3]);
  for (const c of ctx.calls) {
    assert.equal(c.opts.redirect, 'error');
    assert.equal(c.body.SortType, 'JobTitle');
  }
});

test('fetch(): duplicate reqids across pages are dropped; an all-duplicate page stops the walk', async () => {
  const ctx = makeCtx([page(50, 1, 500), page(50, 1, 500), page(50, 101, 500)]);
  const jobs = await br.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 50);
  assert.equal(ctx.calls.length, 2);
});

test('fetch(): DEFAULT_MAX_PAGES / max_pages ceiling stops an endless JobsCount, and warns', async () => {
  const pages = Array.from({ length: 60 }, (_, p) => page(50, p * 50 + 1, 9_999_999));
  const warnings = await captureWarnings(async () => {
    const ctx = makeCtx(pages);
    const jobs = await br.fetch(ENTRY, ctx);
    assert.equal(ctx.calls.length, 40);
    assert.equal(jobs.length, 2000);
    const ctx2 = makeCtx(pages);
    await br.fetch({ ...ENTRY, max_pages: 3 }, ctx2);
    assert.equal(ctx2.calls.length, 3);
    const ctx3 = makeCtx(pages);
    await br.fetch({ ...ENTRY, max_pages: 1e9 }, ctx3);
    assert.equal(ctx3.calls.length, 61); // capped at 200, not 1e9: 60 fixture pages, then the stub's empty page ends it
  });
  assert.ok(warnings.some((w) => /raise max_pages/.test(w)));
});

test('fetch(): ctx.maxPages=1 → exactly one list request, no truncation warning', async () => {
  const warnings = await captureWarnings(async () => {
    const ctx = makeCtx([page(50, 1, 500), page(50, 51, 500)], { maxPages: 1 });
    const jobs = await br.fetch(ENTRY, ctx);
    assert.equal(ctx.calls.length, 1);
    assert.equal(jobs.length, 50);
  });
  assert.equal(warnings.filter((w) => /raise max_pages/.test(w)).length, 0);
});

test('fetch(): a probe-time rejection propagates unwrapped', async () => {
  class ProbePageBudgetReached extends Error {}
  const err = new ProbePageBudgetReached('budget');
  const ctx = makeCtx([err, err, err], { maxPages: 1 });
  await assert.rejects(() => br.fetch(ENTRY, ctx), (e) => e === err);
});

test('fetch(): page-2 5xx that retry cannot clear keeps page 1 and does not claim truncation', async () => {
  const busy = Object.assign(new Error('HTTP 503'), { status: 503 });
  let jobs;
  let ctx;
  const warnings = await captureWarnings(async () => {
    ctx = makeCtx([page(50, 1, 200), busy, busy, busy]);
    jobs = await br.fetch(ENTRY, ctx);
  });
  assert.equal(jobs.length, 50);
  assert.equal(ctx.calls.length, 4); // page 1 + 3 attempts on page 2
  assert.ok(warnings.some((w) => /page 2 failed/.test(w)));
  assert.equal(warnings.filter((w) => /raise max_pages/.test(w)).length, 0);
});

test('fetch(): a first-page failure throws (unreachable, not empty)', async () => {
  const bad = Object.assign(new Error('HTTP 400'), { status: 400 });
  await assert.rejects(() => br.fetch(ENTRY, makeCtx([bad])), /400/);
});

test('fetch(): missing ctx.fetchResponse is a descriptive error, not a silent empty', async () => {
  const ctx = makeCtx([JOBS]);
  delete ctx.fetchResponse;
  await assert.rejects(() => br.fetch(ENTRY, ctx), /fetchResponse is required/);
  assert.equal(ctx.calls.length, 0);
});

test('regression: unknown Jobs container or missing JobsCount is never a silent zero', async () => {
  // review 2 #2: {"Jobs":{"error":"…"}} used to come back as [] with no warning
  assert.throws(() => parseJobsResponse({ Jobs: { error: 'backend unavailable' } }, CFG, []), /Jobs.Job is not an array; Jobs: error/);
  assert.throws(() => parseJobsResponse({ JobsCount: 0, Jobs: { error: 'x' } }, CFG, []), /Jobs.Job is not an array/);
  for (const b of [{ Jobs: null }, { Jobs: { Job: null } }, { Jobs: {} }, { JobsCount: null, Jobs: { Job: null } }, { JobsCount: 'x', Jobs: null }]) {
    assert.throws(() => parseJobsResponse(b, CFG, []), /no JobsCount \(cannot confirm zero jobs\)/, JSON.stringify(b));
  }
  assert.throws(() => parseJobsResponse({ Jobs: { Job: [] } }, CFG, []), /JobsCount is missing/);
  assert.throws(() => parseJobsResponse({ JobsCount: 7, Jobs: { Job: [] } }, CFG, []), /JobsCount is 7/);
  assert.throws(() => parseJobsResponse(null, CFG, []), /unexpected jobs response \(null\)/);
  // a non-empty list needs no JobsCount (later pages may omit it)
  assert.equal(parseJobsResponse({ Jobs: page(2, 1, 0).Jobs }, CFG, []).rows.length, 2);
  await assert.rejects(() => br.fetch(ENTRY, makeCtx([{ Jobs: { error: 'backend unavailable' } }])), /Jobs.Job is not an array/);
  await assert.rejects(() => br.fetch(ENTRY, makeCtx([{ Jobs: { Job: null } }])), /cannot confirm zero jobs/);
});
