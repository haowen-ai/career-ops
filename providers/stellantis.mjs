// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchJsonWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

// Stellantis careers provider (→ tracked_companies:).
//
// careers.stellantis.com is a WordPress "CWS" front end from Symphony Talent
// (m-cloud). The search page is a client-side shell; its config and scripts
// (verified live 2026-11-07 by reading the page, cws.jobs.js and the minified
// CWS.google bundle, then replaying the call) say:
//
//   cws_opts = {"org":"companies/16115603-6c1b-4c45-b544-238a4e6c51b3",
//               "api":"https://jobsapi-google.m-cloud.io/api/", …}
//   CWS.google.filters.search_url(url) → url + '/search'      (= api + 'job/search')
//   CWS.google.filters.search_criteria  maps the widget criteria to:
//     companyName = cws_opts.org
//     pageSize    = Limit (the widget sends 12; the API caps at 100 — 200 falls
//                   back silently to 10)
//     offset      = 0-based row offset
//     query       = keyword text
//     customAttributeFilter = 'country="US"'  for facet primary_country:US
//       (a 2-letter value; a full name like "Algeria" becomes
//        'country_state_city="Algeria"'), AND-joined with other facets
//
//   GET https://jobsapi-google.m-cloud.io/api/job/search?companyName=…&pageSize=100
//       &offset=0&customAttributeFilter=country%3D%22US%22
//   → {"totalHits":412,"nextPageToken":…,"searchResults":[{"summary":…,
//        "job":{"id":24114862,"title":"…","primary_city":"Auburn Hills",
//               "primary_state":"MI","primary_country":"US",
//               "open_date":"2026-11-05T16:02:21",
//               "url":"https://careers.stellantis.com/job/24114862/…/",
//               "seo_url":"https://recruiting.adp.com/…"}}]}
//
// - `job.url` is the posting page on careers.stellantis.com (stable, the
//   dedup key); `seo_url` is the ADP apply link. Both are the employer's own;
//   we keep the careers page and fall back to `/job/{id}/` when it's missing.
// - careers_url query params are honoured the way the site reads them:
//   primary_country, primary_state, primary_category, primary_city and
//   keyword. Anything else is ignored.
// - careers_url host is pinned to careers.stellantis.com; the API host is a
//   fixed literal. `org_id` on the entry overrides the company id.

const ALLOWED_HOSTS = new Set(['careers.stellantis.com']);
const API_URL = 'https://jobsapi-google.m-cloud.io/api/job/search';
const SITE_ORIGIN = 'https://careers.stellantis.com';
const DEFAULT_COMPANY_NAME = 'companies/16115603-6c1b-4c45-b544-238a4e6c51b3';
const PAGE_SIZE = 100; // API maximum
const DEFAULT_MAX_PAGES = 20; // 2,000 rows — the whole global board is ~780
const MAX_PAGES_CAP = 100;
const DEFAULT_MAX_JOBS = 2000;
const INTER_PAGE_DELAY_MS = 200;
const TIMEOUT_MS = 30_000; // a 100-row page is ~0.9 MB (descriptions ride along)

const FACET_PARAMS = ['primary_country', 'primary_state', 'primary_city', 'primary_category'];

/**
 * Validate careers_url/api and derive the API criteria from its query string.
 * Throws on a malformed URL, non-https, or a host outside the allowlist.
 * @param {any} entry
 */
export function resolveConfig(entry) {
  const raw = entry?.api || entry?.careers_url;
  if (typeof raw !== 'string' || !raw) throw new Error('stellantis: careers_url is required');
  const u = new URL(raw); // throws on malformed input
  if (u.protocol !== 'https:') throw new Error(`stellantis: refusing non-https URL ${u.protocol}`);
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) throw new Error(`stellantis: host not allowed: ${u.hostname}`);

  const p = u.searchParams;
  const quote = (v) => JSON.stringify(v);
  const orGroup = (field, values) => (values.length === 1 ? `${field}=${quote(values[0])}` : `(${values.map((v) => `${field}=${quote(v)}`).join(' OR ')})`);
  const split = (v) => String(v || '').split('~').map((s) => s.trim()).filter(Boolean);

  const filters = [];
  const country = split(p.get('primary_country'));
  const state = split(p.get('primary_state'));
  // Mirrors CWS.google map_criteria(): country (+ optional state) becomes the
  // country / country_state custom attribute.
  if (country.length === 1 && state.length === 1) filters.push(`country_state=${quote(`${country[0]}, ${state[0]}`)}`);
  else {
    if (country.length === 1 && country[0].length === 2) filters.push(`country=${quote(country[0])}`);
    else if (country.length) filters.push(orGroup('country_state_city', country));
    if (state.length) filters.push(orGroup('primary_state', state));
  }
  for (const field of FACET_PARAMS.slice(2)) {
    const vals = split(p.get(field));
    if (vals.length) filters.push(orGroup(field, vals));
  }
  const companyName = typeof entry?.org_id === 'string' && /^companies\/[\w-]+$/.test(entry.org_id) ? entry.org_id : DEFAULT_COMPANY_NAME;
  return {
    companyName,
    customAttributeFilter: filters.join(' AND '),
    query: (p.get('keyword') || p.get('keywords') || '').trim(),
  };
}

/** @param {any} cfg @param {number} offset */
export function buildSearchUrl(cfg, offset) {
  const q = new URLSearchParams({ companyName: cfg.companyName, pageSize: String(PAGE_SIZE), offset: String(offset) });
  if (cfg.query) q.set('query', cfg.query);
  if (cfg.customAttributeFilter) q.set('customAttributeFilter', cfg.customAttributeFilter);
  return `${API_URL}?${q.toString()}`;
}

/** ISO-ish date (no zone → UTC) → epoch ms, NaN-safe. @param {unknown} v */
export function toEpochMs(v) {
  if (!v || typeof v !== 'string') return undefined;
  const s = /[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}Z`;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? undefined : ms;
}

/** @param {unknown} s */
function clean(s) {
  return typeof s === 'string' ? decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
}

/** @param {unknown} raw */
function postingUrl(raw, id) {
  if (typeof raw === 'string') {
    try {
      const u = new URL(raw);
      if (u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname.toLowerCase())) return u.href;
    } catch {
      /* fall through */
    }
  }
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return `${SITE_ORIGIN}/job/${id}/`;
  if (typeof id === 'string' && /^\d+$/.test(id)) return `${SITE_ORIGIN}/job/${id}/`;
  return null;
}

/**
 * Parse one search response.
 * - null / non-object / {} / searchResults:null → empty page
 * - an object with neither searchResults nor totalHits → throw (API changed)
 * @param {any} json
 */
export function parseSearchResponse(json) {
  if (json == null || typeof json !== 'object' || Array.isArray(json)) return { rows: [], rawCount: 0, total: 0 };
  const keys = Object.keys(json);
  if (keys.length === 0) return { rows: [], rawCount: 0, total: 0 };
  if (!('searchResults' in json) && !('totalHits' in json)) {
    throw new Error(`stellantis: unexpected search response shape (keys: ${keys.slice(0, 8).join(', ')})`);
  }
  if (json.searchResults != null && !Array.isArray(json.searchResults)) {
    throw new Error('stellantis: unexpected search response (searchResults is not an array)');
  }
  const list = Array.isArray(json.searchResults) ? json.searchResults : [];
  const total = Number.isInteger(json.totalHits) && json.totalHits >= 0 ? json.totalHits : null;
  const rows = [];
  for (const item of list) {
    const job = item?.job;
    if (!job || typeof job !== 'object') continue;
    const title = clean(job.title);
    const url = postingUrl(job.url, job.id);
    if (!title || !url) continue;
    const city = clean(job.primary_city);
    const region = clean(job.primary_state) || clean(job.primary_country);
    rows.push({
      id: (typeof job.id === 'string' || typeof job.id === 'number') ? String(job.id) : url,
      title,
      url,
      location: [city, region].filter(Boolean).join(', '),
      postedAt: toEpochMs(job.open_date),
    });
  }
  return { rows, rawCount: list.length, total };
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
  id: 'stellantis',

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
    const reqOpts = { redirect: 'error', timeoutMs: TIMEOUT_MS, headers: { accept: 'application/json' } };

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
        json = await fetchJsonWithRetry(ctx, buildSearchUrl(cfg, page * PAGE_SIZE), reqOpts);
      } catch (err) {
        if (probing || page === 0) throw err; // unwrapped: probe budget identity must survive
        console.error(`⚠️  stellantis: ${entry.name} page ${page + 1} failed (${err?.message}) — keeping ${jobs.length} postings`);
        stopReason = 'error';
        break;
      }
      const parsed = parseSearchResponse(json);
      if (total === null && parsed.total !== null) total = parsed.total;
      if (parsed.rawCount === 0) break;
      let fresh = 0;
      for (const row of parsed.rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        fresh++;
        const job = { title: row.title, url: row.url, company: entry.name, location: row.location };
        if (typeof row.postedAt === 'number') job.postedAt = row.postedAt;
        jobs.push(job);
      }
      if (jobs.length >= maxJobs) {
        stopReason = 'max_jobs';
        break;
      }
      if (parsed.rawCount < PAGE_SIZE || fresh === 0) break;
      if (total !== null && (page + 1) * PAGE_SIZE >= total) break;
      if (page === pagesToFetch - 1) stopReason = probing ? 'probe' : 'max_pages';
    }

    const out = jobs.slice(0, maxJobs);
    if ((stopReason === 'max_pages' || stopReason === 'max_jobs') && total !== null && out.length < total) {
      console.error(`⚠️  stellantis: ${entry.name} truncated at ${out.length} of ${total} postings — raise max_pages/max_jobs on this entry for more`);
    }
    return out;
  },
};
