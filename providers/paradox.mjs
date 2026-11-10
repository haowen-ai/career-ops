// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchJsonWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

// Paradox career-site provider (→ tracked_companies:).
//
// Paradox (paradox.ai, the "Olivia" recruiting assistant) hosts branded career
// sites for large hourly employers — careers.fedex.com,
// dardenrscjobs.recruiting.com, … The pages are a React shell that the server
// pre-renders with `window.__PRELOAD_STATE__ = {jobSearch:{jobs,totalJob,…},
// company:{page_attributes,…}}` and the page's own JS (jobs-pagination bundle,
// verified live 2026-11-07) pages through:
//
//   POST {origin}/api/get-jobs?page_number={1-based}&page_size={n}&filter[country][0]=…
//        body {"disable_switch_search_mode":…, "site_available_languages":[…]}
//   → {"jobs":[{uniqueID, reference, title, originalURL, applyURL,
//               locations:[{city, stateAbbr, country, countryAbbr, …}], …}],
//      "facets":[…], "totalJob": 2875}
//
// Two things the endpoint insists on (both observed live; without them it
// answers 403 "Access Denied" or 500):
//   1. the anonymous session cookie `ct` the career page sets on a plain GET;
//   2. a same-site Referer.
// So fetch() first GETs careers_url (the same page a browser opens), keeps its
// Set-Cookie, then POSTs the list pages with cookie + Referer. This is the
// site's ordinary anonymous session — no login, no challenge, no CAPTCHA.
//
// page_size: the server accepts only a per-site set of sizes (FedEx: 25/100,
// Darden: 10/20) and silently falls back to its default for anything else.
// We ask for 100 and then page with whatever size page 1 actually returned —
// the fallback is applied to every page_number the same way, so offsets stay
// consistent.
//
// Filters: careers_url query keys of the form `filter[...]` (the site writes
// `?filter[country][0]=United States` into its own URL), plus `keyword` and
// `location`, are forwarded verbatim — so a US-only scan is
//   careers_url: https://careers.fedex.com/jobs?filter%5Bcountry%5D%5B0%5D=United%20States
//
// Posting URL: `originalURL` is relative on some tenants
// ("business-architect/job/P25-358604-1" → careers host) and an absolute
// paradox.ai apply link on others (Darden). Only https URLs on the careers host
// or a *.paradox.ai host are accepted; otherwise `applyURL` under the same
// rule; otherwise the row is skipped.
//
// The list carries no posting date, so postedAt is omitted.
// detect(): branded domains — wire explicitly with `provider: paradox`.

const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 60; // 6,000 rows at 100/page — FedEx US is ~2,900
const MAX_PAGES_CAP = 300;
const DEFAULT_MAX_JOBS = 6000;
const INTER_PAGE_DELAY_MS = 250;
const TIMEOUT_MS = 45_000; // a 100-row page is ~1.1 MB (descriptions ride along)
const FORWARD_KEYS = /^(filter\[[^\]]+\](\[\d*\])?|keyword|location|locationName)$/;
// Hostname allowlist, checked before any request: only career sites verified
// to run on Paradox. Add a host here (after checking it live) to scan a new
// tenant — careers_url alone never widens where we send requests.
export const ALLOWED_HOSTS = new Set(['careers.fedex.com', 'dardenrscjobs.recruiting.com']);

/**
 * Validate careers_url and derive origin, list-page URL and forwarded params.
 * Throws on a malformed URL, non-https, or a host outside ALLOWED_HOSTS
 * before any request.
 * @param {any} entry
 */
export function resolveConfig(entry) {
  const raw = entry?.careers_url || entry?.api;
  if (typeof raw !== 'string' || !raw) throw new Error('paradox: careers_url is required');
  const u = new URL(raw); // throws on malformed input
  if (u.protocol !== 'https:') throw new Error(`paradox: refusing non-https URL ${u.protocol}`);
  if (u.username || u.password) throw new Error('paradox: credentials in careers_url are not allowed');
  const host = u.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host) || (u.port && u.port !== '443')) {
    throw new Error(`paradox: host ${u.host} is not in the allowlist (${[...ALLOWED_HOSTS].join(', ')})`);
  }
  const forward = [];
  for (const [k, v] of u.searchParams) if (FORWARD_KEYS.test(k)) forward.push([k, v]);
  const path = u.pathname && u.pathname !== '/' ? u.pathname : '/jobs';
  return {
    origin: u.origin,
    host,
    pageUrl: `${u.origin}${path}${u.search}`,
    forward,
  };
}

/** @param {any} cfg @param {number} page 1-based @param {number} size */
export function buildListUrl(cfg, page, size = PAGE_SIZE) {
  const q = new URLSearchParams({ page_number: String(page), page_size: String(size) });
  for (const [k, v] of cfg.forward) q.append(k, v);
  return `${cfg.origin}/api/get-jobs?${q.toString()}`;
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

/**
 * The request body the site's JS sends, read from the preload state; `{}`
 * (also accepted live) when the state is absent or unreadable.
 * @param {unknown} html
 */
export function readRequestBody(html) {
  if (typeof html !== 'string') return {};
  const at = html.indexOf('window.__PRELOAD_STATE__');
  if (at < 0) return {};
  const body = {};
  const tail = html.slice(at, at + 400_000);
  const dm = tail.match(/"disable_switch_search_mode"\s*:\s*(true|false)/);
  if (dm) body.disable_switch_search_mode = dm[1] === 'true';
  const lm = tail.match(/"site_available_languages"\s*:\s*(\[[^\]]*\])/);
  if (lm) {
    try {
      const langs = JSON.parse(lm[1]);
      if (Array.isArray(langs) && langs.every((x) => typeof x === 'string')) body.site_available_languages = langs;
    } catch {
      /* leave it out */
    }
  }
  return body;
}

/** @param {unknown} s */
function clean(s) {
  return typeof s === 'string' ? decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
}

/** @param {unknown} raw @param {any} cfg */
function acceptUrl(raw, cfg) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let u;
  try {
    u = new URL(raw.trim(), `${cfg.origin}/`);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const h = u.hostname.toLowerCase();
  if (h !== cfg.host && h !== 'paradox.ai' && !h.endsWith('.paradox.ai')) return null;
  return u.href;
}

/** @param {unknown} loc */
function formatLocation(loc) {
  if (!loc || typeof loc !== 'object') return '';
  const l = /** @type {any} */ (loc);
  const city = clean(l.city);
  const state = clean(l.stateAbbr) || clean(l.state);
  const cc = clean(l.countryAbbr);
  const parts = [city, state].filter(Boolean);
  if (cc && cc !== 'US') parts.push(clean(l.country) || cc);
  if (!parts.length) return clean(l.locationParsedText) || clean(l.locationText);
  return parts.join(', ');
}

/**
 * Parse one get-jobs response.
 * - a JSON object with a `jobs` array → rows (malformed rows skipped)
 * - anything else (null, array, string, error envelope, jobs not an array) → throw
 * @param {any} json @param {any} cfg
 */
export function parseJobsResponse(json, cfg) {
  if (json == null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(`paradox: get-jobs returned ${json === null ? 'null' : Array.isArray(json) ? 'an array' : typeof json}, expected an object`);
  }
  if (!Array.isArray(json.jobs)) {
    const keys = Object.keys(json).slice(0, 8).join(', ') || '(none)';
    throw new Error(`paradox: unexpected get-jobs response (jobs is ${json.jobs === undefined ? 'missing' : 'not an array'}; keys: ${keys})`);
  }
  const total = Number.isInteger(json.totalJob) && json.totalJob >= 0 ? json.totalJob : null;
  const rows = [];
  for (const job of json.jobs) {
    if (!job || typeof job !== 'object') continue;
    const title = clean(job.title);
    const url = acceptUrl(job.originalURL, cfg) || acceptUrl(job.applyURL, cfg);
    if (!title || !url) continue;
    const id = typeof job.uniqueID === 'string' && job.uniqueID
      ? job.uniqueID
      : (typeof job.reference === 'string' && job.reference ? job.reference : url);
    const locs = Array.isArray(job.locations) ? job.locations : [];
    let location = formatLocation(locs[0]);
    if (locs.length > 1 && location) location += ` (+${locs.length - 1} more)`;
    rows.push({ id, title, url, location });
  }
  return { rows, rawCount: json.jobs.length, total };
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
  id: 'paradox',

  detect() {
    return null; // branded hosts — explicit `provider: paradox` only
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry); // throws before any request on a bad URL
    if (typeof ctx?.fetchResponse !== 'function') throw new Error('paradox: ctx.fetchResponse is required (session cookie)');

    // 1. The career page: issues the anonymous session cookie the API needs.
    const res = await ctx.fetchResponse(cfg.pageUrl, { redirect: 'error', timeoutMs: TIMEOUT_MS, headers: { accept: 'text/html' } });
    const setCookies = typeof res?.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const cookie = cookieHeader(setCookies);
    if (!/(^|;\s*)ct=/.test(cookie)) {
      throw new Error(`paradox: ${cfg.pageUrl} issued no session cookie (ct) — not a Paradox career site, or the site changed`);
    }
    const html = typeof res?.text === 'function' ? await res.text() : '';
    const body = JSON.stringify(readRequestBody(html));
    const reqOpts = {
      method: 'POST',
      body,
      redirect: 'error',
      timeoutMs: TIMEOUT_MS,
      headers: { 'content-type': 'application/json', accept: 'application/json', cookie, referer: cfg.pageUrl },
    };

    // 2. The list pages.
    const ctxMaxPages = Number(ctx?.maxPages);
    const probing = ctxMaxPages > 0;
    const maxPages = resolveMaxPages(entry);
    const pagesToFetch = Math.min(maxPages, probing ? ctxMaxPages : Infinity);
    const maxJobs = resolveMaxJobs(entry);

    const jobs = [];
    const seen = new Set();
    let total = null;
    let pageSize = null; // the size the server actually applies (see header)
    let stopReason = 'end';
    for (let page = 1; page <= pagesToFetch; page++) {
      if (page > 1) await sleep(INTER_PAGE_DELAY_MS, ctx);
      let json;
      try {
        json = await fetchJsonWithRetry(ctx, buildListUrl(cfg, page), reqOpts);
      } catch (err) {
        if (probing || page === 1) throw err; // unwrapped: probe budget identity must survive
        console.error(`⚠️  paradox: ${entry.name} page ${page} failed (${err?.message}) — keeping ${jobs.length} postings`);
        stopReason = 'error';
        break;
      }
      const parsed = parseJobsResponse(json, cfg);
      if (total === null && parsed.total !== null) total = parsed.total;
      if (parsed.rawCount === 0) break;
      if (pageSize === null) pageSize = parsed.rawCount;
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
      // A full-looking walk can return a short page mid-list (seen live: FedEx
      // page 8 = 99 rows of 100), so the short-page stop applies only when the
      // server gave no total.
      if (total !== null ? page * pageSize >= total : parsed.rawCount < pageSize) break;
      if (page === pagesToFetch) stopReason = probing ? 'probe' : 'max_pages';
    }

    const out = jobs.slice(0, maxJobs);
    if ((stopReason === 'max_pages' || stopReason === 'max_jobs') && total !== null && out.length < total) {
      console.error(`⚠️  paradox: ${entry.name} truncated at ${out.length} of ${total} postings — raise max_pages/max_jobs on this entry for more`);
    }
    return out;
  },
};
