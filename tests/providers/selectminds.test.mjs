// tests/providers/selectminds.test.mjs — Oracle Taleo SelectMinds career
// community (server-rendered /<COMMUNITY>/jobs/search/<sid>[/pageN]).
//
// The fixture is a trimmed live page (2026-11-08, Energy Transfer /ETP):
// one real row, one row with a percent-encoded slug, two malformed rows.
// No network — ctx is stubbed.
//
// Run:  node --test tests/providers/selectminds.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/selectminds.mjs')).href);
const sm = mod.default;
const { resolveConfig, parsePage, searchIdFromLocation, buildPageUrl } = mod;

const FIXTURE = readFileSync(join(ROOT, 'tests/fixtures/selectminds-results.html'), 'utf8');
const ORIGIN = 'https://energytransfer.referrals.selectminds.com';
const ENTRY = { name: 'Energy Transfer', careers_url: `${ORIGIN}/ETP/` };
const CFG = resolveConfig(ENTRY);

function redirect(location, status = 307) {
  const e = new Error(`HTTP ${status}`);
  e.status = status;
  e.location = location;
  return e;
}
function pageHtml(total, ids) {
  return `<span class="total_results">${total}</span>` + ids.map((id) =>
    `<div id="job_list_${id}" class="job_list_row"><a href="${ORIGIN}/ETP/jobs/job-${id}" class="job_link font_bold">Job ${id}</a><span class="location"> Dallas, Texas </span></div>`).join('');
}
function makeCtx(handler) {
  const calls = [];
  return {
    calls,
    sleep: async () => {},
    fetchText: async (url, opts) => {
      calls.push({ url, opts });
      const b = handler(new URL(url), opts);
      if (b instanceof Error) throw b;
      if (b === undefined) throw new Error(`unexpected request ${url}`);
      return b;
    },
  };
}
const range = (a, n) => Array.from({ length: n }, (_, i) => a + i);

test('id, detect(), resolveConfig() allowlists', () => {
  assert.equal(sm.id, 'selectminds');
  assert.deepEqual(CFG, { host: 'energytransfer.referrals.selectminds.com', community: 'ETP', origin: ORIGIN });
  assert.ok(sm.detect(ENTRY));
  for (const bad of [
    `http://energytransfer.referrals.selectminds.com/ETP/`,
    `https://energytransfer.referrals.selectminds.com.evil.example/ETP/`,
    `https://evil.example/ETP/`,
    `https://energytransfer.referrals.selectminds.com/`,
    `https://energytransfer.referrals.selectminds.com:444/ETP/`,
  ]) {
    assert.throws(() => resolveConfig({ careers_url: bad }), Error, bad);
  }
});

test('searchIdFromLocation(): only a same-host result-set redirect is accepted', () => {
  assert.equal(searchIdFromLocation('/ETP/jobs/search/9726016', CFG), '9726016');
  assert.equal(searchIdFromLocation(`${ORIGIN}/ETP/jobs/search/9726016`, CFG), '9726016');
  assert.throws(() => searchIdFromLocation('https://evil.example/ETP/jobs/search/1', CFG), /off-host/);
  assert.throws(() => searchIdFromLocation('/OTHER/jobs/search/1', CFG), /unexpected search redirect/);
  assert.throws(() => searchIdFromLocation(null, CFG), /did not redirect/);
  assert.equal(buildPageUrl(CFG, '42', 3), `${ORIGIN}/ETP/jobs/search/42/page3`);
});

test('parsePage(): fixture rows mapped (encoded slug ok), malformed rows skipped', () => {
  const res = parsePage(FIXTURE, CFG, 'Energy Transfer');
  assert.equal(res.total, 4);
  assert.equal(res.rawCount, 4);
  assert.equal(res.skipped, 2);
  assert.deepEqual(res.jobs.map((j) => [j.id, j.title]), [['15437', 'Specialist - IT SCADA'], ['19307', 'Intern – Project Engineering']]);
  assert.equal(res.jobs[0].url, `${ORIGIN}/ETP/jobs/specialist-it-scada-15437`);
  assert.equal(res.jobs[0].location, 'HOUSTON, Texas, United States');
});

test('parsePage(): unknown shapes throw', () => {
  assert.throws(() => parsePage('', CFG, 'x'), /empty results page/);
  assert.throws(() => parsePage('<html>blocked</html>', CFG, 'x'), /no total_results/);
  assert.throws(() => parsePage('<span class="total_results">3</span><div id="job_list_1" class="job_list_row"><p>x</p></div>', CFG, 'x'), /none parsed/);
  assert.throws(() => parsePage(`<span class="total_results">3</span><a href="${ORIGIN}/ETP/jobs/a-1" class="job_link">A</a>`, CFG, 'x'), /markup changed/);
  assert.deepEqual(parsePage('<span class="total_results">0</span>', CFG, 'x').jobs, []);
});

test('fetch(): opens a result set (manual redirect), pages until total; redirect refused on pages', async () => {
  const ctx = makeCtx((u, opts) => {
    if (u.pathname === '/ETP/jobs/search') return opts.redirect === 'manual' ? redirect('/ETP/jobs/search/777') : new Error('must be manual');
    if (u.pathname === '/ETP/jobs/search/777') return pageHtml(25, range(1, 10));
    if (u.pathname === '/ETP/jobs/search/777/page2') return pageHtml(25, range(11, 9)).replace('class="job_list_row">', 'class="job_list_row"><a href="https://evil.example/x-1" class="job_link">bad</a>') + '<div id="job_list_99" class="job_list_row"><p>bad</p></div>';
    if (u.pathname === '/ETP/jobs/search/777/page3') return pageHtml(25, range(21, 5));
    return undefined;
  });
  const jobs = await sm.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 23); // page 2: first row has an off-host link (skipped) + one link-less row
  assert.equal(ctx.calls.length, 4);
  for (const c of ctx.calls.slice(1)) assert.equal(c.opts.redirect, 'error');
});

test('fetch(): shortfall warns truncated; max_pages bound; guard first; non-redirect search throws', async () => {
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const many = makeCtx((u) => (u.pathname === '/ETP/jobs/search' ? redirect('/ETP/jobs/search/5') : pageHtml(10000, range(Math.floor(Math.random() * 1e9), 10))));
    await sm.fetch({ ...ENTRY, max_pages: 2 }, many);
    assert.equal(many.calls.length, 3);
  } finally {
    console.error = orig;
  }
  assert.ok(errs.some((e) => /truncated \(max_pages=2\)/.test(e)), errs.join('\n'));
  await assert.rejects(sm.fetch(ENTRY, makeCtx(() => '<html>no redirect</html>')), /did not redirect/);
  await assert.rejects(sm.fetch(ENTRY, makeCtx(() => redirect('https://evil.example/ETP/jobs/search/1'))), /off-host/);
  const none = makeCtx(() => undefined);
  await assert.rejects(sm.fetch({ name: 'x', careers_url: 'https://evil.example/ETP/' }, none), /host not allowed/);
  assert.equal(none.calls.length, 0);
});
