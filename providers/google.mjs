// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { BROWSER_LIKE_USER_AGENT, fetchTextWithRetry } from './_http.mjs';

// Google Careers provider (→ tracked_companies:). Google runs its own career
// site; there is no third-party ATS and no public JSON API. The search page
// itself is server-rendered and embeds the result page as one Closure data
// island, which is what the browser renders from:
//
//   GET https://www.google.com/about/careers/applications/jobs/results/
//       ?location=United%20States[&target_level=…][&q=…]&page=<N>   (1-based)
//
//   <script class="ds:1" …>AF_initDataCallback({key: 'ds:1', hash: '…',
//     data:[ [ <job>, … ] | null, null, <total>, <pageSize> ], sideChannel: {}});
//
// Per <job> array (positional, verified live 2026-11-08):
//   [0] id (digits, string)   [1] title   [7] company display name
//   [9] locations: [[ "Mountain View, CA, USA", [...], city, zip, state, cc ], …]
//   [12] [epochSeconds, nanos] (created)
// The public posting page is
//   https://www.google.com/about/careers/applications/jobs/results/<id>-<slug>
// (the same href the search page links to).
//
// Page size is fixed by the server (20). 1,758 US jobs on 11/08 → 88 pages of
// ~1.3 MB each; pages are paced and the loop is bounded by max_pages.
//
// careers_url carries the search filters; only the keys in ALLOWED_PARAMS are
// forwarded (`page` is owned by the provider). Host and path are pinned before
// any request; redirects are refused.
//
// Failure policy:
//   - no ds:1 island, unparsable island, or a shape that is not
//     [jobs|null, *, total:number, pageSize:number] → throw (site changed);
//   - a malformed job row is skipped and counted, never fatal; a page whose
//     rows are all malformed throws;
//   - paging uses the raw row count, not the parsed count, so one bad row
//     cannot stop pagination; a short page before `total` is reached does not
//     end the loop (the next page is still asked for), and a final shortfall
//     against `total` is reported as truncated on stderr.

const HOST = 'www.google.com';
const PATH = '/about/careers/applications/jobs/results/';
const ALLOWED_PARAMS = new Set([
  'location', 'q', 'target_level', 'employment_type', 'degree', 'company',
  'skills', 'has_remote', 'sort_by', 'distance', 'jex',
]);
const DEFAULT_MAX_PAGES = 150;
const MAX_PAGES_CAP = 500;
const INTER_PAGE_DELAY_MS = 400;
const RETRY_POLICY = { retries: 3, baseDelayMs: 1000, maxDelayMs: 10_000 };
const ID_RE = /^\d{5,30}$/;

/**
 * Validate careers_url (host + path pinned) and keep the allowed filters.
 * Throws before any request on anything else.
 *
 * @param {any} entry
 * @returns {{params: Array<[string,string]>}}
 */
export function resolveConfig(entry) {
  const raw = entry?.careers_url || entry?.api;
  if (typeof raw !== 'string' || !raw) throw new Error('google: careers_url is required');
  const u = new URL(raw); // throws on malformed input
  if (u.protocol !== 'https:') throw new Error(`google: refusing non-https URL ${u.protocol}`);
  if (u.hostname.toLowerCase() !== HOST) throw new Error(`google: host not allowed: ${u.hostname}`);
  if (u.username || u.password || u.port) throw new Error('google: credentials/port not allowed in careers_url');
  const path = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
  if (path !== PATH) throw new Error(`google: careers_url path must be ${PATH}, got ${u.pathname}`);
  /** @type {Array<[string,string]>} */
  const params = [];
  for (const [k, v] of u.searchParams) {
    if (k === 'page') continue;
    if (!ALLOWED_PARAMS.has(k)) throw new Error(`google: unsupported careers_url parameter ${JSON.stringify(k)}`);
    params.push([k, v]);
  }
  return { params };
}

/**
 * @param {{params: Array<[string,string]>}} cfg
 * @param {number} page 1-based
 */
export function buildPageUrl(cfg, page) {
  const sp = new URLSearchParams();
  for (const [k, v] of cfg.params) sp.append(k, v);
  if (page > 1) sp.set('page', String(page));
  const qs = sp.toString();
  return `https://${HOST}${PATH}${qs ? `?${qs}` : ''}`;
}

/** @param {string} url */
function assertGoogleUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== HOST || !u.pathname.startsWith(PATH)) {
    throw new Error(`google: refusing request to ${url}`);
  }
  return url;
}

/**
 * Return the end index (exclusive) of the JSON value starting at `start`
 * (which must be '[' or '{'), honouring strings and escapes. -1 if unbalanced.
 *
 * @param {string} s
 * @param {number} start
 */
function scanJsonValue(s, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Pull the ds:1 data array out of a search page. Throws when missing or
 * unparsable.
 *
 * @param {string} html
 * @returns {any[]}
 */
export function extractResultsIsland(html) {
  if (typeof html !== 'string' || !html) throw new Error('google: empty search page');
  const m = /AF_initDataCallback\(\{\s*key:\s*'ds:1'\s*,\s*hash:\s*'[^']*'\s*,\s*data:\s*/.exec(html);
  if (!m) throw new Error('google: search page has no ds:1 results island (page layout changed or request blocked)');
  const start = m.index + m[0].length;
  if (html[start] !== '[') throw new Error('google: ds:1 data is not an array');
  const end = scanJsonValue(html, start);
  if (end < 0) throw new Error('google: ds:1 data island is truncated');
  try {
    return JSON.parse(html.slice(start, end));
  } catch (err) {
    throw new Error(`google: ds:1 data island is not valid JSON (${/** @type {Error} */ (err).message})`);
  }
}

/** @param {string} title */
export function slugify(title) {
  return title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
}

/**
 * Parse one page's island. Throws on an unknown shape; skips malformed rows.
 *
 * @param {unknown} data
 * @param {string} companyName
 * @returns {{jobs: Array<{id:string,title:string,url:string,company:string,location:string,postedAt?:number}>, rawCount:number, skipped:number, total:number, pageSize:number}}
 */
export function parseResultsPage(data, companyName) {
  if (!Array.isArray(data) || data.length < 4) throw new Error('google: ds:1 data has an unexpected shape (expected [jobs, _, total, pageSize])');
  const [rows, , total, pageSize] = data;
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) throw new Error(`google: ds:1 total is not a number (${JSON.stringify(total)})`);
  if (typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize <= 0 || pageSize > 200) throw new Error(`google: ds:1 page size is not a positive integer (${JSON.stringify(pageSize)})`);
  if (rows !== null && !Array.isArray(rows)) throw new Error('google: ds:1 job list is neither an array nor null');
  const list = rows ?? [];
  const jobs = [];
  let skipped = 0;
  for (const r of list) {
    try {
      if (!Array.isArray(r)) { skipped++; continue; }
      const id = typeof r[0] === 'string' ? r[0].trim() : '';
      const title = typeof r[1] === 'string' ? r[1].replace(/\s+/g, ' ').trim() : '';
      if (!ID_RE.test(id) || !title) { skipped++; continue; }
      const locs = [];
      if (Array.isArray(r[9])) {
        for (const l of r[9]) {
          const name = Array.isArray(l) && typeof l[0] === 'string' ? l[0].trim() : '';
          if (name) locs.push(name);
        }
      }
      const slug = slugify(title);
      /** @type {{id:string,title:string,url:string,company:string,location:string,postedAt?:number}} */
      const job = {
        id,
        title,
        url: `https://${HOST}${PATH}${id}${slug ? `-${slug}` : ''}`,
        company: companyName,
        location: [...new Set(locs)].join(' · '),
      };
      const secs = Array.isArray(r[12]) ? Number(r[12][0]) : NaN;
      if (Number.isFinite(secs) && secs > 0) job.postedAt = Math.round(secs * 1000);
      jobs.push(job);
    } catch {
      skipped++;
    }
  }
  if (list.length > 0 && jobs.length === 0) throw new Error(`google: ${list.length} rows on the page but none parsed (row shape changed?)`);
  return { jobs, rawCount: list.length, skipped, total, pageSize };
}

/** @param {any} entry @param {any} ctx */
function resolveMaxPages(entry, ctx) {
  const v = entry?.max_pages;
  const fromEntry = Number.isInteger(v) && v > 0 ? Math.min(v, MAX_PAGES_CAP) : DEFAULT_MAX_PAGES;
  const hint = Number(ctx?.maxPages);
  return Number.isFinite(hint) && hint > 0 ? Math.min(fromEntry, Math.floor(hint)) : fromEntry;
}

/** @param {number} ms @param {any} ctx */
function sleep(ms, ctx) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @type {Provider} */
export default {
  id: 'google',

  detect(entry) {
    try {
      const raw = entry?.careers_url || entry?.api;
      if (typeof raw !== 'string') return null;
      const cfg = resolveConfig({ careers_url: raw });
      return { url: buildPageUrl(cfg, 1) };
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry); // throws before any request
    const maxPages = resolveMaxPages(entry, ctx);
    const seen = new Set();
    const all = [];
    let raw = 0;
    let skipped = 0;
    /** @type {number|null} */
    let total = null;
    let pagesFetched = 0;

    for (let page = 1; page <= maxPages; page++) {
      if (page > 1) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const url = assertGoogleUrl(buildPageUrl(cfg, page));
      const html = await fetchTextWithRetry(ctx, url, {
        redirect: 'error',
        headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
      }, RETRY_POLICY);
      pagesFetched = page;
      const res = parseResultsPage(extractResultsIsland(html), entry.name);
      if (total === null) total = res.total;
      raw += res.rawCount;
      skipped += res.skipped;
      for (const j of res.jobs) {
        if (seen.has(j.id)) continue;
        seen.add(j.id);
        all.push(j);
      }
      if (res.rawCount === 0) break; // past the end
      if (raw >= total) break;
      if (page * res.pageSize >= total && res.rawCount < res.pageSize) break;
    }

    if (skipped > 0) console.error(`⚠️  google: ${entry.name} skipped ${skipped} malformed rows`);
    if (total !== null && raw < total) {
      const why = pagesFetched >= maxPages ? `max_pages=${maxPages}` : 'short pages';
      console.error(`⚠️  google: ${entry.name} truncated (${why}): ${raw} of ${total} rows read — raise max_pages or narrow the careers_url filters`);
    }
    return all;
  },
};
