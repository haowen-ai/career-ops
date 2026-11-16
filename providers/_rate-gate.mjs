// @ts-check
// providers/_rate-gate.mjs — one request pace shared by every tenant of a provider in this process.
//
// Why: Workday throttles per client IP across all of its clusters (*.wdN.myworkdayjobs.com), not per tenant.
// The scan reads hundreds of Workday tenants in parallel lanes inside one Node process, each lane pacing only
// itself, so the sum could reach ~600 requests a minute; after a heavy day the IP was answered 429 from the
// first request, and every lane kept retrying into it (career-journal plan 2026-11-14 v8).
//
// The gate:
// - spaces requests evenly: at most `rpm` a minute across all tenants, never a burst;
// - on a 429 from any tenant pauses ALL of them: cooldown = min(maxCooldownMs, max(Retry-After,
//   baseCooldownMs * 2^(k-1))), k = 429 episodes in a row without a 2xx; each episode also halves the pace
//   (down to rpm / 8) for the rest of the process;
// - after `breakerAfter` episodes in a row stops sending: every later request fails at once with a
//   429-shaped error (status 429, retryAfter '0', code 'rate_gate_breaker_open') without touching the network.
// Every wait re-checks the state when it wakes, so a request that was already waiting honours a cooldown, a
// slower pace or an open breaker that appeared while it slept. Waits are abortable.
//
// The gate only delays requests or fails them the way the server would have; how a provider reports a list
// that was cut short (partial / error) is unchanged.

import { abortableSleep, parseRetryAfterMs } from './_http.mjs';
import { currentAbortSignal } from './_connection-scope.mjs';

export const BREAKER_OPEN_CODE = 'rate_gate_breaker_open';

const DEFAULTS = Object.freeze({
  baseCooldownMs: 60_000,
  maxCooldownMs: 600_000,
  breakerAfter: 5,
  maxSlowdown: 8,
});

/**
 * Requests-per-minute from an env value: a positive number, 'off' (no gate), or unset (the fallback).
 * Anything else falls back with a warning, so a typo never stops the scan.
 *
 * @param {string | undefined} raw
 * @param {number} fallback
 * @param {string} name - Env variable name, for the warning.
 * @returns {number | null} null = gate off.
 */
export function resolveRpm(raw, fallback, name) {
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const text = String(raw).trim().toLowerCase();
  if (text === 'off') return null;
  const value = Number(text);
  if (Number.isFinite(value) && value > 0) return value;
  console.error(`⚠️  ${name}=${JSON.stringify(raw)} is not a positive number or "off"; using ${fallback} requests/minute`);
  return fallback;
}

/**
 * @param {{ rpm: number, label?: string, now?: () => number, baseCooldownMs?: number, maxCooldownMs?: number,
 *   breakerAfter?: number, maxSlowdown?: number }} options
 */
export function createRateGate(options) {
  const { rpm, label = 'rate gate', now = Date.now } = options;
  const { baseCooldownMs, maxCooldownMs, breakerAfter, maxSlowdown } = { ...DEFAULTS, ...options };
  if (!(Number.isFinite(rpm) && rpm > 0)) throw new Error(`${label}: rpm must be a positive number`);
  const baseIntervalMs = 60_000 / rpm;
  const state = {
    intervalMs: baseIntervalMs,
    nextAt: -Infinity,
    cooldownUntil: -Infinity,
    cooldownStartedAt: -Infinity,
    consecutive429: 0,
    breakerOpen: false,
    dispatched: 0,
    rateLimited: 0,
  };

  const breakerError = () => Object.assign(
    new Error(`${label}: rate-limit breaker open after ${state.consecutive429} consecutive 429 episodes; request not sent`),
    { status: 429, retryAfter: '0', code: BREAKER_OPEN_CODE },
  );

  /**
   * Wait for this request's turn. Returns the dispatch time.
   * @param {{ sleep?: (ms: number) => Promise<void> }} [ctx]
   */
  async function take(ctx) {
    for (;;) {
      if (state.breakerOpen) throw breakerError();
      const signal = currentAbortSignal();
      if (signal?.aborted) throw Object.assign(new Error(`${label}: aborted while waiting for its turn`), { name: 'AbortError' });
      const t = now();
      const readyAt = Math.max(state.cooldownUntil, state.nextAt);
      if (t >= readyAt) {
        state.nextAt = t + state.intervalMs;
        state.dispatched += 1;
        return t;
      }
      await abortableSleep(readyAt - t, ctx, signal);
    }
  }

  /** @param {number} dispatchedAt @param {unknown} retryAfter */
  function on429(dispatchedAt, retryAfter) {
    state.rateLimited += 1;
    const t = now();
    const retryAfterMs = parseRetryAfterMs(typeof retryAfter === 'string' ? retryAfter : null);
    // Requests already in flight when an episode began are part of that episode, not new ones.
    if (dispatchedAt > state.cooldownStartedAt) {
      state.consecutive429 += 1;
      state.cooldownStartedAt = t;
      state.intervalMs = Math.min(state.intervalMs * 2, baseIntervalMs * maxSlowdown);
      if (state.consecutive429 >= breakerAfter) {
        state.breakerOpen = true;
        console.error(`⚠️  ${label}: ${state.consecutive429} consecutive 429 episodes; no more requests this run`);
        return;
      }
      const backoff = baseCooldownMs * 2 ** (state.consecutive429 - 1);
      const cooldown = Math.min(maxCooldownMs, Math.max(retryAfterMs ?? 0, backoff));
      state.cooldownUntil = Math.max(state.cooldownUntil, t + cooldown);
      console.error(`⚠️  ${label}: 429 (episode ${state.consecutive429}); all requests pause ${Math.round(cooldown / 1000)} s, pace now ${Math.round(60_000 / state.intervalMs)}/min`);
    } else if (retryAfterMs !== null) {
      state.cooldownUntil = Math.max(state.cooldownUntil, t + Math.min(maxCooldownMs, retryAfterMs));
    }
  }

  function onSuccess() {
    state.consecutive429 = 0;
  }

  /**
   * A ctx whose fetchJson / fetchText / fetchResponse go through the gate. Everything else the caller's ctx
   * carries stays reachable (Object.create, as workday.mjs's meteredCtx does).
   * @template {object} T
   * @param {T} ctx
   * @returns {T}
   */
  function wrap(ctx) {
    const gated = Object.create(ctx);
    for (const name of ['fetchJson', 'fetchText', 'fetchResponse']) {
      const original = /** @type {any} */ (ctx)[name];
      if (typeof original !== 'function') continue;
      gated[name] = async (/** @type {any[]} */ ...args) => {
        const dispatchedAt = await take(/** @type {any} */ (ctx));
        try {
          const result = await original.apply(ctx, args);
          onSuccess();
          return result;
        } catch (err) {
          const e = /** @type {any} */ (err);
          if (e?.status === 429 && e?.code !== BREAKER_OPEN_CODE) on429(dispatchedAt, e.retryAfter);
          else if (typeof e?.status === 'number' && e.status < 400) onSuccess();
          throw err;
        }
      };
    }
    return gated;
  }

  return { take, on429, onSuccess, wrap, state };
}
