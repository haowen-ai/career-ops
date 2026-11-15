// tests/providers/eightfold-v2-429.test.mjs — HTTP 429 on the classic v2 walk
// of providers/eightfold.mjs (fork, plan v7a Netflix). Eightfold's edge answers
// 429 to this machine for tens of seconds once its shared limit is spent; the
// generic retry (0.5 s to 8 s) gave up inside that window and the board came
// back partial. A 429 now gets a cooldown (Retry-After when sent, never shorter
// than the v2 cooldown) and the SAME page is asked again; only a limit that
// outlasts every cooldown ends the walk, still tagged partial.
// Run: node --test tests/providers/eightfold-v2-429.test.mjs  (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = await import(pathToFileURL(join(ROOT, 'providers/eightfold.mjs')).href);
const ef = mod.default;
const { V2_RATE_LIMIT_COOLDOWN_MS: RATE_LIMIT_COOLDOWN_MS, V2_RATE_LIMIT_RETRIES: RATE_LIMIT_RETRIES, MAX_RETRY_AFTER_MS } = mod;

const ENTRY = { name: 'Netflix', careers_url: 'https://netflix.eightfold.ai/careers?domain=netflix.com' };
const TOTAL = 42; // rows on the synthetic board: five pages, the last one short
const rows = (start) => Array.from({ length: Math.max(0, Math.min(10, TOTAL - start)) }, (_, i) => ({
  id: String(start + i), name: `Role ${start + i}`, canonicalPositionUrl: `https://netflix.eightfold.ai/careers/job/${start + i}`,
}));
const http429 = (retryAfter = null) => Object.assign(new Error('HTTP 429 Too Many Requests'), { status: 429, retryAfter });

/** A v2 board; `limitedFor(start, nthCallForThatStart)` decides which calls answer 429. */
function board(limitedFor) {
  const slept = [];
  const seen = new Map();
  const starts = [];
  const ctx = {
    transport: 'http',
    sleep: async (ms) => { slept.push(ms); },
    fetchText: async () => { throw new Error('no fetchText'); },
    fetchJson: async (url) => {
      const u = new URL(url);
      assert.equal(u.pathname, '/api/apply/v2/jobs', `unexpected request ${url}`);
      const start = Number(u.searchParams.get('start'));
      const n = (seen.get(start) ?? 0) + 1;
      seen.set(start, n);
      starts.push(start);
      const limited = limitedFor(start, n);
      if (limited) throw http429(typeof limited === 'string' ? limited : null);
      return { positions: rows(start), count: TOTAL };
    },
  };
  return { ctx, slept, starts };
}

const ids = (jobs) => jobs.map((j) => j.url).sort();
const fullIds = ids(Array.from({ length: TOTAL }, (_, i) => ({ url: `https://netflix.eightfold.ai/careers/job/${i}` })));

test('exports the cooldown knobs', () => {
  assert.equal(typeof RATE_LIMIT_COOLDOWN_MS, 'number');
  assert.equal(typeof RATE_LIMIT_RETRIES, 'number');
  assert.equal(typeof MAX_RETRY_AFTER_MS, 'number');
  assert.ok(MAX_RETRY_AFTER_MS >= RATE_LIMIT_COOLDOWN_MS);
});

test('a mid-walk 429 that outlasts the generic retry: cooldown, same page again, whole board, not partial', async () => {
  // start=20: the first 8 calls answer 429 (two full generic-retry rounds), then it lifts.
  const { ctx, slept, starts } = board((start, n) => start === 20 && n <= 8);
  const jobs = await ef.fetch(ENTRY, ctx);
  assert.equal(jobs.length, TOTAL);
  assert.deepEqual(ids(jobs), fullIds);
  assert.equal(jobs.eightfoldTruncated, undefined);
  assert.ok(slept.includes(RATE_LIMIT_COOLDOWN_MS), `no cooldown: ${slept}`);
  // never skipped ahead: every start is asked in order, the limited one repeated
  const order = starts.filter((s, i) => i === 0 || s !== starts[i - 1]);
  assert.deepEqual(order, [0, 10, 20, 30, 40]);
});

test('Retry-After is honoured when it is longer than the cooldown, and clamped', async () => {
  {
    const { ctx, slept } = board((start, n) => start === 10 && n <= 4 && '90');
    const jobs = await ef.fetch(ENTRY, ctx);
    assert.equal(jobs.length, TOTAL);
    assert.ok(slept.includes(90_000), `Retry-After 90 s not honoured: ${slept}`);
  }
  {
    const { ctx, slept } = board((start, n) => start === 10 && n <= 4 && '86400');
    const jobs = await ef.fetch(ENTRY, ctx);
    assert.equal(jobs.length, TOTAL);
    assert.ok(Math.max(...slept) <= MAX_RETRY_AFTER_MS, `Retry-After not clamped: ${Math.max(...slept)}`);
  }
  {
    // a Retry-After shorter than the cooldown never shortens it
    const { ctx, slept } = board((start, n) => start === 10 && n <= 4 && '1');
    await ef.fetch(ENTRY, ctx);
    assert.ok(slept.includes(RATE_LIMIT_COOLDOWN_MS), `cooldown shortened by Retry-After: ${slept}`);
  }
});

test('after a 429 the rest of the board is paced slower', async () => {
  const { ctx, slept } = board((start, n) => start === 10 && n <= 4);
  await ef.fetch(ENTRY, ctx);
  const afterCooldown = slept.slice(slept.indexOf(RATE_LIMIT_COOLDOWN_MS) + 1);
  assert.ok(afterCooldown.length > 0 && afterCooldown.every((ms) => ms >= 1000), `page delay not raised: ${afterCooldown}`);
});

test('a first-page 429 that lifts after a cooldown returns the whole board', async () => {
  const { ctx } = board((start, n) => start === 0 && n <= 4);
  const jobs = await ef.fetch(ENTRY, ctx);
  assert.deepEqual(ids(jobs), fullIds);
  assert.equal(jobs.eightfoldTruncated, undefined);
});

test('a limit that never lifts: bounded cooldowns, pages kept, still tagged partial', async () => {
  const { ctx, slept, starts } = board((start) => start >= 20);
  const jobs = await ef.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 20);
  assert.equal(jobs.eightfoldTruncated, true);
  assert.equal(slept.filter((ms) => ms >= RATE_LIMIT_COOLDOWN_MS).length, RATE_LIMIT_RETRIES);
  assert.ok(starts.every((s) => s <= 20), `walked past the limited page: ${starts}`);
});

test('a first-page limit that never lifts is rethrown, never an empty board', async () => {
  const { ctx } = board(() => true);
  await assert.rejects(ef.fetch(ENTRY, ctx), (err) => err.status === 429);
});
