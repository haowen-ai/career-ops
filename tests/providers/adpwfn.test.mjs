// tests/providers/adpwfn.test.mjs — ADP Workforce Now career center
// (public job-requisitions JSON behind workforcenow.adp.com recruitment.html).
//
// The fixture is a trimmed live response (2026-11-08, Thor Industries): two
// real rows plus three malformed ones. No network — ctx is stubbed.
//
// Run:  node --test tests/providers/adpwfn.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/adpwfn.mjs')).href);
const adp = mod.default;
const { resolveConfig, buildApiUrl, buildJobUrl, parsePage } = mod;

const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/adpwfn-job-requisitions.json'), 'utf8'));
const CID = 'a4c08bd3-eedf-419a-9fb6-5d2ac8a3bafa';
const ENTRY = { name: 'Thor Industries', careers_url: `https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=${CID}&ccId=19000101_000001&lang=en_US` };
const CFG = resolveConfig(ENTRY);

function rows(n, base) {
  return Array.from({ length: n }, (_, i) => ({ itemID: `${base + i}_1`, requisitionTitle: `Job ${base + i}`, requisitionLocations: [{ nameCode: { shortName: ' Elkhart, IN, US' } }] }));
}
function makeCtx(bodies) {
  const calls = [];
  let i = 0;
  return {
    calls,
    sleep: async () => {},
    fetchJson: async (url, opts) => {
      calls.push({ url, opts });
      const b = typeof bodies === 'function' ? bodies(new URL(url)) : bodies[i++];
      if (b instanceof Error) throw b;
      if (b === undefined) throw new Error(`unexpected request ${url}`);
      return b;
    },
  };
}

test('id, detect(), resolveConfig() allowlists', () => {
  assert.equal(adp.id, 'adpwfn');
  assert.deepEqual(CFG, { cid: CID, ccId: '19000101_000001', lang: 'en_US' });
  assert.ok(adp.detect(ENTRY));
  assert.equal(adp.detect({ careers_url: 'https://myjobs.adp.com/murphyusa/cx/job-listing' }), null);
  for (const bad of [
    ENTRY.careers_url.replace('https:', 'http:'),
    ENTRY.careers_url.replace('workforcenow.adp.com', 'workforcenow.adp.com.evil.example'),
    ENTRY.careers_url.replace('/mascsr/default/mdf/recruitment/recruitment.html', '/other'),
    ENTRY.careers_url.replace(CID, 'not-a-uuid'),
    ENTRY.careers_url.replace('19000101_000001', 'x'),
    'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html',
  ]) {
    assert.throws(() => resolveConfig({ careers_url: bad }), Error, bad);
  }
});

test('buildApiUrl()/buildJobUrl()', () => {
  const u = new URL(buildApiUrl(CFG, 200));
  assert.equal(u.hostname, 'workforcenow.adp.com');
  assert.equal(u.pathname, '/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions');
  assert.equal(u.searchParams.get('cid'), CID);
  assert.equal(u.searchParams.get('$top'), '100');
  assert.equal(u.searchParams.get('$skip'), '200');
  assert.equal(new URL(buildJobUrl(CFG, '9202037049483_1')).searchParams.get('jobId'), '9202037049483_1');
});

test('parsePage(): fixture rows mapped, malformed rows skipped', () => {
  const res = parsePage(FIXTURE, CFG, 'Thor Industries');
  assert.equal(res.rawCount, 5);
  assert.equal(res.skipped, 3);
  assert.equal(res.total, 5);
  const [a] = res.jobs;
  assert.equal(a.title, '2nd Shift Welders');
  assert.equal(a.location, 'Elkhart, IN, US');
  assert.equal(a.url, buildJobUrl(CFG, '9202037049483_1'));
  assert.equal(a.postedAt, Date.parse('2026-09-24T19:43:00'));
});

test('parsePage(): unknown shapes throw', () => {
  assert.throws(() => parsePage(null, CFG, 'x'), /not a JSON object/);
  assert.throws(() => parsePage([], CFG, 'x'), /not a JSON object/);
  assert.throws(() => parsePage({ error: 'nope' }, CFG, 'x'), /no jobRequisitions array/);
  assert.throws(() => parsePage({ jobRequisitions: [] }, CFG, 'x'), /totalNumber/);
  assert.throws(() => parsePage({ jobRequisitions: [{}, { itemID: 'a b' }], meta: { totalNumber: 2 } }, CFG, 'x'), /none parsed/);
  assert.deepEqual(parsePage({ jobRequisitions: [], meta: { totalNumber: 0 } }, CFG, 'x').jobs, []);
});

test('fetch(): pages by raw count via $skip; bad row does not stop paging; redirect refused', async () => {
  const ctx = makeCtx((u) => {
    const skip = Number(u.searchParams.get('$skip'));
    if (skip === 0) return { jobRequisitions: [...rows(99, 1000), { itemID: 'bad id' }], meta: { totalNumber: 130 } };
    if (skip === 100) return { jobRequisitions: rows(30, 2000), meta: { totalNumber: 130 } };
    return undefined;
  });
  const jobs = await adp.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 129);
  assert.equal(ctx.calls.length, 2);
  for (const c of ctx.calls) assert.equal(c.opts.redirect, 'error');
});

test('fetch(): empty page before totalNumber → truncated warning; max_pages bound; guard first', async () => {
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const ctx = makeCtx([{ jobRequisitions: rows(100, 1), meta: { totalNumber: 500 } }, { jobRequisitions: [], meta: { totalNumber: 500 } }]);
    assert.equal((await adp.fetch(ENTRY, ctx)).length, 100);
    const many = makeCtx((u) => ({ jobRequisitions: rows(100, Number(u.searchParams.get('$skip')) + 10), meta: { totalNumber: 1e6 } }));
    await adp.fetch({ ...ENTRY, max_pages: 2 }, many);
    assert.equal(many.calls.length, 2);
  } finally {
    console.error = orig;
  }
  assert.ok(errs.some((e) => /truncated \(short pages\): 100 of 500/.test(e)), errs.join('\n'));
  assert.ok(errs.some((e) => /max_pages=2/.test(e)));
  const none = makeCtx([]);
  await assert.rejects(adp.fetch({ name: 'x', careers_url: 'https://evil.example/mascsr/default/mdf/recruitment/recruitment.html' }, none), /host not allowed/);
  assert.equal(none.calls.length, 0);
});
