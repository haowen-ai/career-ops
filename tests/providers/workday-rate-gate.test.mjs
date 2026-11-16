// One request pace for every Workday tenant in the process (career-journal plan 2026-11-14 v8): Workday throttles
// per client IP across all clusters, so tenants must share one requests-per-minute cap, pause together on a 429 and
// stop sending once 429s keep coming.
//
// Run: node --test tests/providers/workday-rate-gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import workday, { workdayGateFor } from '../../providers/workday.mjs';
import { createRateGate, resolveRpm, BREAKER_OPEN_CODE } from '../../providers/_rate-gate.mjs';
import { withAbortScope } from '../../providers/_connection-scope.mjs';

// A fake clock: sleep advances time instead of waiting; timers fire in time order.
function fakeClock() {
  let t = 0;
  const timers = [];
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  const clock = {
    now: () => t,
    sleep: (ms) => new Promise((resolve) => { timers.push({ at: t + Math.max(0, ms), resolve }); }),
    // Run until nothing is pending (or a step limit), advancing to each next timer.
    async run(limit = 100_000) {
      for (let i = 0; i < limit; i++) {
        await flush();
        if (!timers.length) return;
        timers.sort((a, b) => a.at - b.at);
        const next = timers.shift();
        t = Math.max(t, next.at);
        next.resolve();
      }
      throw new Error('fake clock: step limit reached');
    },
  };
  return clock;
}

const err429 = (retryAfter = null) => Object.assign(new Error('HTTP 429 Too Many Requests'), { status: 429, retryAfter });

// Drives promises to completion on the fake clock and returns their settled results.
async function settle(clock, promises) {
  const all = Promise.allSettled(promises);
  await clock.run();
  return all;
}

test('requests from several tenants are spaced at the shared pace (120/min -> 500 ms)', async () => {
  const clock = fakeClock();
  const gate = createRateGate({ rpm: 120, now: clock.now, label: 'workday' });
  const starts = [];
  const ctxFor = () => gate.wrap({ sleep: clock.sleep, fetchJson: async () => { starts.push(clock.now()); return {}; } });
  const tenants = [ctxFor(), ctxFor(), ctxFor()];
  const jobs = [];
  for (const ctx of tenants) jobs.push((async () => { for (let i = 0; i < 4; i++) await ctx.fetchJson('https://x.wd1.myworkdayjobs.com/a'); })());
  await settle(clock, jobs);
  assert.equal(starts.length, 12);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 500, `gap ${i}: ${starts[i] - starts[i - 1]} ms`);
});

test('a 429 pauses every tenant, including requests already waiting; Retry-After is honoured; pace halves', async () => {
  const clock = fakeClock();
  const gate = createRateGate({ rpm: 120, now: clock.now, label: 'workday' });
  const starts = [];
  let first = true;
  const ctx = gate.wrap({ sleep: clock.sleep, fetchJson: async () => {
    starts.push(clock.now());
    if (first) { first = false; throw err429('90'); }
    return {};
  } });
  // Three requests queued at once: the second and third are already waiting when the first gets its 429.
  const results = await settle(clock, [ctx.fetchJson('u'), ctx.fetchJson('u'), ctx.fetchJson('u')]);
  assert.equal(results[0].status, 'rejected');
  assert.deepEqual(results.slice(1).map((r) => r.status), ['fulfilled', 'fulfilled']);
  assert.equal(starts[0], 0);
  assert.ok(starts[1] >= 90_000, `second request at ${starts[1]} ms, before the 90 s Retry-After`);
  assert.ok(starts[2] - starts[1] >= 1_000, `pace after a 429 is 60/min: gap ${starts[2] - starts[1]} ms`);
});

test('without Retry-After the cooldown is 60 s, then 120 s for the next episode; a 2xx resets the count', async () => {
  const clock = fakeClock();
  const gate = createRateGate({ rpm: 120, now: clock.now, label: 'workday' });
  const plan = ['429', '429', 'ok', '429', 'ok'];
  const starts = [];
  const ctx = gate.wrap({ sleep: clock.sleep, fetchJson: async () => {
    starts.push(clock.now());
    if (plan[starts.length - 1] === '429') throw err429();
    return {};
  } });
  const run = (async () => { for (let i = 0; i < plan.length; i++) await ctx.fetchJson('u').catch(() => {}); })();
  await settle(clock, [run]);
  assert.ok(starts[1] - starts[0] >= 60_000 && starts[1] - starts[0] < 61_000, `first cooldown ${starts[1] - starts[0]}`);
  assert.ok(starts[2] - starts[1] >= 120_000 && starts[2] - starts[1] < 121_000, `second cooldown ${starts[2] - starts[1]}`);
  // After the 2xx the next 429 is episode 1 again: 60 s.
  assert.ok(starts[4] - starts[3] >= 60_000 && starts[4] - starts[3] < 61_000, `cooldown after reset ${starts[4] - starts[3]}`);
});

test('in-flight requests that 429 together count as one episode', async () => {
  const clock = fakeClock();
  const gate = createRateGate({ rpm: 6000, now: clock.now, label: 'workday' });
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const ctx = gate.wrap({ sleep: clock.sleep, fetchJson: async () => { calls += 1; if (calls <= 3) { await hold; throw err429(); } return {}; } });
  const inFlight = [ctx.fetchJson('u'), ctx.fetchJson('u'), ctx.fetchJson('u')].map((p) => p.catch((e) => e));
  await clock.run();
  assert.equal(calls, 3);
  release();
  await Promise.all(inFlight);
  assert.equal(gate.state.consecutive429, 1);
  assert.equal(gate.state.breakerOpen, false);
});

test('the breaker opens on the 5th episode: waiting and later requests fail without being sent', async () => {
  const clock = fakeClock();
  const gate = createRateGate({ rpm: 120, now: clock.now, label: 'workday' });
  let sent = 0;
  const ctx = gate.wrap({ sleep: clock.sleep, fetchJson: async () => { sent += 1; throw err429(); } });
  const results = await settle(clock, Array.from({ length: 8 }, () => ctx.fetchJson('u')));
  assert.equal(sent, 5);
  assert.equal(gate.state.breakerOpen, true);
  const blocked = results.slice(5).map((r) => r.status === 'rejected' && r.reason);
  for (const reason of blocked) {
    assert.equal(reason.status, 429);
    assert.equal(reason.code, BREAKER_OPEN_CODE);
    assert.equal(reason.retryAfter, '0');
  }
  // Cooldowns before the breaker: 60 + 120 + 240 + 480 s.
  assert.ok(clock.now() >= 900_000 && clock.now() < 905_000, `time spent ${clock.now()}`);
});

test('an abort while waiting ends the wait without sending', async () => {
  const clock = fakeClock();
  const gate = createRateGate({ rpm: 1, now: clock.now, label: 'workday' });
  let sent = 0;
  const ctx = gate.wrap({ sleep: clock.sleep, fetchJson: async () => { sent += 1; return {}; } });
  await settle(clock, [ctx.fetchJson('u')]);
  const controller = new AbortController();
  const waiting = withAbortScope(controller.signal, () => ctx.fetchJson('u')).catch((e) => e);
  await Promise.resolve();
  controller.abort();
  const result = await waiting;
  assert.equal(sent, 1);
  assert.equal(result?.name, 'AbortError');
});

test('resolveRpm: number, off, unset, garbage', () => {
  assert.equal(resolveRpm('60', 120, 'X'), 60);
  assert.equal(resolveRpm('off', 120, 'X'), null);
  assert.equal(resolveRpm(undefined, 120, 'X'), 120);
  const errors = [];
  const original = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try { assert.equal(resolveRpm('fast', 120, 'X'), 120); } finally { console.error = original; }
  assert.equal(errors.length, 1);
});

// --- wired into workday.fetch ----------------------------------------------------------------------------------

const ENTRY = { name: 'Acme', careers_url: 'https://acme.wd1.myworkdayjobs.com/acme' };
const page = (offset, total) => ({ total, jobPostings: Array.from({ length: Math.min(20, total - offset) }, (_, i) => ({
  title: `Role ${offset + i}`, externalPath: `/job/Remote/Role_R${offset + i}`, locationsText: 'Remote', postedOn: 'Posted Today' })) });

// The process-wide gate is built once from CAREER_OPS_WORKDAY_RPM; each case pins the env and a fresh slot.
function withSharedGateEnv(value, fn) {
  const KEY = Symbol.for('career-ops.workday.rate-gate');
  const hadGate = KEY in globalThis;
  const savedGate = globalThis[KEY];
  const hadEnv = 'CAREER_OPS_WORKDAY_RPM' in process.env;
  const savedEnv = process.env.CAREER_OPS_WORKDAY_RPM;
  delete globalThis[KEY];
  if (value === undefined) delete process.env.CAREER_OPS_WORKDAY_RPM; else process.env.CAREER_OPS_WORKDAY_RPM = value;
  try { return fn(); } finally {
    if (hadGate) globalThis[KEY] = savedGate; else delete globalThis[KEY];
    if (hadEnv) process.env.CAREER_OPS_WORKDAY_RPM = savedEnv; else delete process.env.CAREER_OPS_WORKDAY_RPM;
  }
}

test('workdayGateFor: the shared gate for the real transport, an injected gate otherwise, none for workdayGate: null', () => {
  withSharedGateEnv(undefined, () => {
    const shared = workdayGateFor({ transport: 'http' });
    assert.ok(shared, 'real transport gets a gate');
    assert.equal(shared.state.intervalMs, 500, 'default 120 requests/minute');
    assert.equal(workdayGateFor({ transport: 'http' }), shared, 'one gate per process');
    assert.equal(workdayGateFor({ transport: 'http', workdayGate: null }), null);
    const injected = createRateGate({ rpm: 60 });
    assert.equal(workdayGateFor({ transport: 'http', workdayGate: injected }), injected);
    assert.equal(workdayGateFor({ fetchJson: async () => ({}) }), null, 'a stub without the http transport is not gated');
  });
  withSharedGateEnv('60', () => assert.equal(workdayGateFor({ transport: 'http' }).state.intervalMs, 1000));
  withSharedGateEnv('off', () => assert.equal(workdayGateFor({ transport: 'http' }), null, "'off' turns the shared gate off"));
});

test('workday.fetch sends every page through the gate', async () => {
  const clock = fakeClock();
  const gate = createRateGate({ rpm: 120, now: clock.now, label: 'workday' });
  const starts = [];
  const ctx = { transport: 'http', sleep: clock.sleep, workdayGate: gate, fetchText: async () => { throw new Error('no'); },
    fetchJson: async (_url, opts) => { starts.push(clock.now()); return page(JSON.parse(opts.body).offset, 60); } };
  const [result] = await settle(clock, [workday.fetch(ENTRY, ctx)]);
  assert.equal(result.status, 'fulfilled');
  assert.equal(result.value.length, 60);
  assert.equal(gate.state.dispatched, 3);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 500);
});

test('a tenant cut short by the breaker mid-list is reported truncated (partial), never complete', async () => {
  const clock = fakeClock();
  const gate = createRateGate({ rpm: 120, now: clock.now, label: 'workday', breakerAfter: 1 });
  let sent = 0;
  const ctx = { transport: 'http', sleep: clock.sleep, workdayGate: gate, fetchText: async () => { throw new Error('no'); },
    fetchJson: async (_url, opts) => { sent += 1; const offset = JSON.parse(opts.body).offset; if (offset === 20) throw err429(); return page(offset, 60); } };
  const [result] = await settle(clock, [workday.fetch(ENTRY, ctx)]);
  assert.equal(result.status, 'fulfilled');
  assert.equal(result.value.length, 20);
  assert.equal(result.value.workdayTruncated, 'transient');
  assert.equal(sent, 2, 'after the breaker opens, retries of the page are not sent');
});

test('a first page refused by an open breaker throws (the bridge reports error), without a request', async () => {
  const clock = fakeClock();
  const gate = createRateGate({ rpm: 120, now: clock.now, label: 'workday', breakerAfter: 1 });
  gate.on429(0, null);
  let sent = 0;
  const ctx = { transport: 'http', sleep: clock.sleep, workdayGate: gate, fetchText: async () => { sent += 1; throw new Error('no'); },
    fetchJson: async () => { sent += 1; return page(0, 20); } };
  const [result] = await settle(clock, [workday.fetch(ENTRY, ctx)]);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason.status, 429);
  assert.equal(sent, 0);
});
