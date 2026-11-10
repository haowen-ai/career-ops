// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchJsonWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

// Best Buy careers provider (→ tracked_companies:).
//
// jobs.bestbuy.com is a ServiceNow Service Portal ("bby") with a custom
// NewRocket job-search widget. The "Search all Open Jobs" page
// (/bby?id=all_jobs) loads its list from that widget's server script, the way
// every Service Portal widget talks to its server (verified live 2026-11-07 by
// reading the widget's client script and replaying the call):
//
//   POST https://jobs.bestbuy.com/api/now/sp/widget/dd786d721b71b010b4c011f18c4bcb87?id=all_jobs
//        headers  X-UserToken: {g_ck}   + the portal session cookies
//        body     {"action":"update_data","options":{"items_per_page":500,
//                  "lastLimit":{0-based offset},"sort":"req_id_num",
//                  "filters":{"country":"countrySTARTSWITHUS"},
//                  "limitResults":"limitResults"}}
//   → {"result":{"data":{"total_count":2441,"items":{"features":[
//        {"properties":{"auto_req_id":"1055582BR","title":"…","city":"Fullerton",
//                       "state":"California","country":"United States",
//                       "last_updated":"07-Nov-2026",…}}, …]}}}}
//
// - X-UserToken is ServiceNow's per-session CSRF token for the anonymous
//   (guest) portal user; the portal shell embeds it as `var g_ck = '…'` and
//   sets the session cookies (JSESSIONID, glide_*) on a plain GET. fetch()
//   GETs the shell once (~1 MB), then pages the widget. Without the token the
//   widget answers 201 with `"invalid_token": true` and no data — that envelope
//   is a THROW here, never an empty board.
// - Posting page: /bby?id=job_details&req_id={auto_req_id} (the widget's own
//   ng-template builds exactly this link).
// - careers_url `country=XX` becomes the widget filter
//   countrySTARTSWITHXX, as bestBuyCareerQueryService does; no country → no
//   filter (the board is US-only today).
// - `last_updated` is an update date, not a posting date, so postedAt is
//   omitted.

const ALLOWED_HOSTS = new Set(['jobs.bestbuy.com']);
const ORIGIN = 'https://jobs.bestbuy.com';
const SHELL_URL = `${ORIGIN}/bby?id=all_jobs`;
const DEFAULT_WIDGET_ID = 'dd786d721b71b010b4c011f18c4bcb87';
const PAGE_SIZE = 500; // honoured live (2,441 rows → 5 pages of ~300 KB)
const DEFAULT_MAX_PAGES = 20; // 10,000 rows
const MAX_PAGES_CAP = 100;
const DEFAULT_MAX_JOBS = 10_000;
const INTER_PAGE_DELAY_MS = 250;
const TIMEOUT_MS = 30_000;

/** @param {any} entry */
export function resolveConfig(entry) {
  const raw = entry?.careers_url || entry?.api;
  if (typeof raw !== 'string' || !raw) throw new Error('bestbuy: careers_url is required');
  const u = new URL(raw); // throws on malformed input
  if (u.protocol !== 'https:') throw new Error(`bestbuy: refusing non-https URL ${u.protocol}`);
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) throw new Error(`bestbuy: host not allowed: ${u.hostname}`);
  const cc = (u.searchParams.get('country') || '').trim().toUpperCase();
  const filters = /^[A-Z]{2}$/.test(cc) ? { country: `countrySTARTSWITH${cc}` } : {};
  const widgetId = typeof entry?.widget_id === 'string' && /^[0-9a-f]{32}$/.test(entry.widget_id) ? entry.widget_id : DEFAULT_WIDGET_ID;
  return { filters, widgetUrl: `${ORIGIN}/api/now/sp/widget/${widgetId}?id=all_jobs` };
}

/** @param {ReturnType<typeof resolveConfig>} cfg @param {number} offset */
export function buildBody(cfg, offset) {
  return JSON.stringify({
    action: 'update_data',
    options: {
      items_per_page: PAGE_SIZE,
      initial_page: 0,
      current_page: 0,
      lastLimit: offset,
      sort: 'req_id_num',
      filters: cfg.filters,
      limitResults: 'limitResults',
    },
  });
}

/** Cookie header from Set-Cookie lines; drops deleted (empty) cookies. @param {unknown} lines */
export function cookieHeader(lines) {
  const jar = new Map();
  for (const raw of Array.isArray(lines) ? lines : []) {
    if (typeof raw !== 'string') continue;
    const pair = raw.split(';', 1)[0].trim();
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value) jar.set(name, value);
    else jar.delete(name);
  }
  return [...jar].map(([n, v]) => `${n}=${v}`).join('; ');
}

/** The guest session's CSRF token from the portal shell. @param {unknown} html */
export function extractToken(html) {
  if (typeof html !== 'string') return null;
  const m = html.match(/\bg_ck\s*=\s*['"]([0-9a-f]{20,128})['"]/i);
  return m ? m[1] : null;
}

/** @param {unknown} s */
function clean(s) {
  return typeof s === 'string' ? decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
}

/**
 * Parse one widget response.
 * - result.data.items.features array → rows (malformed rows skipped)
 * - invalid_token, a missing result/data/items, or features not an array → throw
 * @param {any} json
 */
export function parseWidgetResponse(json) {
  if (json == null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(`bestbuy: widget returned ${json === null ? 'null' : Array.isArray(json) ? 'an array' : typeof json}, expected an object`);
  }
  const result = json.result;
  if (!result || typeof result !== 'object') {
    const msg = typeof json.error?.message === 'string' ? `: ${json.error.message}` : '';
    throw new Error(`bestbuy: widget response has no result (keys: ${Object.keys(json).slice(0, 8).join(', ') || '(none)'})${msg}`);
  }
  if (result.invalid_token) throw new Error('bestbuy: widget rejected the session token (invalid_token)');
  const data = result.data;
  if (!data || typeof data !== 'object') {
    throw new Error(`bestbuy: widget response has no data (result keys: ${Object.keys(result).slice(0, 8).join(', ') || '(none)'})`);
  }
  const features = data.items?.features;
  if (!Array.isArray(features)) {
    throw new Error(`bestbuy: unexpected widget data (items.features is ${features === undefined ? 'missing' : 'not an array'}; data keys: ${Object.keys(data).slice(0, 8).join(', ')})`);
  }
  const total = Number.isInteger(data.total_count) && data.total_count >= 0 ? data.total_count : null;
  const rows = [];
  for (const f of features) {
    const p = f?.properties;
    if (!p || typeof p !== 'object') continue;
    const title = clean(p.title);
    const req = typeof p.auto_req_id === 'string' ? p.auto_req_id.trim() : '';
    if (!title || !/^[A-Za-z0-9_-]{1,40}$/.test(req)) continue;
    const city = clean(p.city);
    const state = clean(p.state);
    const country = clean(p.country);
    const parts = [city, state].filter(Boolean);
    if (country && country !== 'United States') parts.push(country);
    rows.push({
      id: req,
      title,
      url: `${ORIGIN}/bby?id=job_details&req_id=${encodeURIComponent(req)}`,
      location: parts.join(', '),
    });
  }
  return { rows, rawCount: features.length, total };
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

function resolveMaxJobs(entry) {
  const v = entry?.max_jobs;
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_MAX_JOBS;
}

/** @type {Provider} */
export default {
  id: 'bestbuy',

  detect(entry) {
    try {
      const raw = entry?.careers_url || entry?.api;
      if (typeof raw !== 'string') return null;
      const u = new URL(raw);
      if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname.toLowerCase())) return null;
      return { url: u.href };
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry); // throws before any request on a bad host
    if (typeof ctx?.fetchResponse !== 'function') throw new Error('bestbuy: ctx.fetchResponse is required (session cookie)');

    // 1. Portal shell: guest session cookies + X-UserToken.
    const res = await ctx.fetchResponse(SHELL_URL, { redirect: 'error', timeoutMs: TIMEOUT_MS, headers: { accept: 'text/html' } });
    const cookie = cookieHeader(typeof res?.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : []);
    const token = extractToken(typeof res?.text === 'function' ? await res.text() : '');
    if (!token) throw new Error(`bestbuy: no session token (g_ck) on ${SHELL_URL} — the portal changed`);
    if (!cookie) throw new Error(`bestbuy: ${SHELL_URL} set no session cookies — the portal changed`);
    const headers = { 'content-type': 'application/json', accept: 'application/json', 'x-usertoken': token, cookie };

    // 2. Widget pages.
    const ctxMaxPages = Number(ctx?.maxPages);
    const probing = ctxMaxPages > 0;
    const maxPages = resolveMaxPages(entry);
    const pagesToFetch = Math.min(maxPages, probing ? ctxMaxPages : Infinity);
    const maxJobs = resolveMaxJobs(entry);

    const jobs = [];
    const seen = new Set();
    let total = null;
    let stopReason = 'end';
    for (let page = 0; page < pagesToFetch; page++) {
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
      let json;
      try {
        json = await fetchJsonWithRetry(ctx, cfg.widgetUrl, {
          method: 'POST',
          body: buildBody(cfg, page * PAGE_SIZE),
          redirect: 'error',
          timeoutMs: TIMEOUT_MS,
          headers,
        });
      } catch (err) {
        if (probing || page === 0) throw err; // unwrapped: probe budget identity must survive
        console.error(`⚠️  bestbuy: ${entry.name} page ${page + 1} failed (${err?.message}) — keeping ${jobs.length} postings`);
        stopReason = 'error';
        break;
      }
      const parsed = parseWidgetResponse(json);
      if (total === null && parsed.total !== null) total = parsed.total;
      if (parsed.rawCount === 0) break;
      let fresh = 0;
      for (const row of parsed.rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        fresh++;
        jobs.push({ title: row.title, url: row.url, company: entry.name, location: row.location });
      }
      if (jobs.length >= maxJobs) {
        stopReason = 'max_jobs';
        break;
      }
      if (fresh === 0) break;
      // Short-page stop only without a total: a mid-list page can come back short.
      if (total !== null ? (page + 1) * PAGE_SIZE >= total : parsed.rawCount < PAGE_SIZE) break;
      if (page === pagesToFetch - 1) stopReason = probing ? 'probe' : 'max_pages';
    }

    const out = jobs.slice(0, maxJobs);
    if ((stopReason === 'max_pages' || stopReason === 'max_jobs') && total !== null && out.length < total) {
      console.error(`⚠️  bestbuy: ${entry.name} truncated at ${out.length} of ${total} postings — raise max_pages/max_jobs on this entry for more`);
    }
    return out;
  },
};
