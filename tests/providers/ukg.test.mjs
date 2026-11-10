// tests/providers/ukg.test.mjs — UKG Pro Recruiting (UltiPro) job board
// (POST …/JobBoardView/LoadSearchResults on recruiting.ultipro.com).
//
// The fixture is a trimmed live response (2026-11-08, Welltower): two real
// rows plus three malformed ones. No network — ctx is stubbed.
//
// Run:  node --test tests/providers/ukg.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/ukg.mjs')).href);
const ukg = mod.default;
const { resolveConfig, parsePage, buildSearchBody } = mod;

const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/ukg-search-results.json'), 'utf8'));
const BOARD = '30969ce4-3b7e-40a6-b86c-34d3616fe0ed';
const ENTRY = { name: 'Welltower', careers_url: `https://recruiting.ultipro.com/WEL1008WLLT/JobBoard/${BOARD}/` };
const CFG = resolveConfig(ENTRY);

const guid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rows = (n, base) => Array.from({ length: n }, (_, i) => ({ Id: guid(base + i), Title: `Job ${base + i}`, Locations: [{ Address: { City: 'Toledo', State: { Code: 'OH' }, Country: { Code: 'USA' } } }] }));

function makeCtx(fn) {
  const calls = [];
  return {
    calls,
    sleep: async () => {},
    fetchJson: async (url, opts) => {
      calls.push({ url, opts });
      const b = fn(JSON.parse(opts.body).opportunitySearch.Skip, url);
      if (b instanceof Error) throw b;
      if (b === undefined) throw new Error('unexpected request');
      return b;
    },
  };
}

test('id, detect(), resolveConfig() allowlists', () => {
  assert.equal(ukg.id, 'ukg');
  assert.equal(CFG.base, `https://recruiting.ultipro.com/WEL1008WLLT/JobBoard/${BOARD}`);
  assert.ok(ukg.detect(ENTRY));
  assert.ok(resolveConfig({ careers_url: `https://recruiting2.ultipro.com/ABC1000/JobBoard/${BOARD}/?q=&o=postedDateDesc` }));
  for (const bad of [
    ENTRY.careers_url.replace('https:', 'http:'),
    ENTRY.careers_url.replace('recruiting.ultipro.com', 'recruiting.ultipro.com.evil.example'),
    ENTRY.careers_url.replace('recruiting.ultipro.com', 'evil.example'),
    `https://recruiting.ultipro.com/WEL1008WLLT/JobBoard/not-a-uuid/`,
    `https://recruiting.ultipro.com/../JobBoard/${BOARD}/`,
    `https://recruiting.ultipro.com:8443/WEL1008WLLT/JobBoard/${BOARD}/`,
  ]) {
    assert.throws(() => resolveConfig({ careers_url: bad }), Error, bad);
  }
});

test('parsePage(): fixture rows mapped, malformed rows skipped', () => {
  const res = parsePage(FIXTURE, CFG, 'Welltower');
  assert.equal(res.rawCount, 5);
  assert.equal(res.skipped, 3);
  assert.equal(res.jobs[0].title, 'Invoice Analyst');
  assert.equal(res.jobs[0].url, `${CFG.base}/OpportunityDetail?opportunityId=ab6abb0f-a27c-42b7-b276-29da4ec0f71a`);
  assert.equal(res.jobs[0].location, 'Frisco, TX, USA');
  assert.equal(res.jobs[0].postedAt, Date.parse('2026-11-06T21:59:06.649Z'));
});

test('parsePage(): unknown shapes throw', () => {
  assert.throws(() => parsePage(null, CFG, 'x'), /not a JSON object/);
  assert.throws(() => parsePage({ message: 'error' }, CFG, 'x'), /no opportunities array/);
  assert.throws(() => parsePage({ opportunities: [] }, CFG, 'x'), /totalCount/);
  assert.throws(() => parsePage({ opportunities: [{ Id: 'x', Title: 'y' }], totalCount: 1 }, CFG, 'x'), /none parsed/);
  assert.deepEqual(parsePage({ opportunities: [], totalCount: 0 }, CFG, 'x').jobs, []);
});

test('fetch(): POST pages by raw Skip; bad row does not stop paging; redirect refused', async () => {
  const ctx = makeCtx((skip) => (skip === 0 ? { opportunities: [...rows(49, 1), { Id: 'bad' }], totalCount: 70 }
    : skip === 50 ? { opportunities: rows(20, 100), totalCount: 70 } : undefined));
  const jobs = await ukg.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 69);
  assert.equal(ctx.calls.length, 2);
  for (const c of ctx.calls) {
    assert.equal(c.opts.method, 'POST');
    assert.equal(c.opts.redirect, 'error');
    assert.equal(new URL(c.url).hostname, 'recruiting.ultipro.com');
  }
  assert.equal(JSON.parse(buildSearchBody(50)).opportunitySearch.Top, 50);
});

test('fetch(): shortfall warns truncated; max_pages bound; guard first', async () => {
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const ctx = makeCtx((skip) => (skip === 0 ? { opportunities: rows(50, 1), totalCount: 300 } : { opportunities: [], totalCount: 300 }));
    assert.equal((await ukg.fetch(ENTRY, ctx)).length, 50);
    const many = makeCtx((skip) => ({ opportunities: rows(50, skip + 1), totalCount: 1e6 }));
    await ukg.fetch({ ...ENTRY, max_pages: 3 }, many);
    assert.equal(many.calls.length, 3);
  } finally {
    console.error = orig;
  }
  assert.ok(errs.some((e) => /truncated \(short pages\): 50 of 300/.test(e)), errs.join('\n'));
  assert.ok(errs.some((e) => /max_pages=3/.test(e)));
  const none = makeCtx(() => undefined);
  await assert.rejects(ukg.fetch({ name: 'x', careers_url: `https://evil.example/A/JobBoard/${BOARD}/` }, none), /host not allowed/);
  assert.equal(none.calls.length, 0);
});
