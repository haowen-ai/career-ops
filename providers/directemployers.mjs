// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchJsonWithRetry, sleep } from './_http.mjs';

// DirectEmployers / NLx "microsite" provider (→ tracked_companies:).
//
// Branded career sites such as careers.alaskaair.com (Alaska Air Group:
// Alaska Airlines, Hawaiian Airlines, Horizon Air) are Nuxt apps hosted by
// DirectEmployers (assets on seo.nlx.org). The page is a client-rendered
// shell; the job list comes from one shared search API, scoped to the site
// by an `X-Origin` request header (verified live 2026-11-11 by reading the
// site's bundles and replaying the call with plain HTTP — no bot wall):
//
//   GET https://prod-search-api.jobsyn.org/api/v1/solr/search?page={1-based}
//   X-Origin: careers.alaskaair.com
//   → {"jobs":[…],"featured_jobs":[…],"filters":{…},"meta":{…},
//      "pagination":{"page":1,"page_size":10,"total":70,"total_pages":7,
//                    "has_more_pages":true,"offset":0}}
//
// - 10 rows per page; num_items / page_size / rows are ignored (the site
//   itself asks for num_items=10). Past the end: 200, jobs [], has_more false.
// - Page 1 carries `featured_jobs` (same row shape). On 2026-11-11 the jobs
//   pages held 69 unique rows and one featured row appeared on no page —
//   jobs ∪ featured = 70 = pagination.total — so featured rows are merged in
//   and everything is de-duplicated by guid.
// - Row fields used: guid (32 hex), title_exact, title_slug, location_exact,
//   reqid, date_new (ISO), description (markdown, carried for free).
// - Posting URL, as the site's own router builds it (route
//   `/:location/:title/:guid/job/`, link builder in the site bundle):
//     https://{host}/{slug(location_exact)}/{title_slug}/{guid}/job/
//   The detail view loads the posting by guid and rewrites a stale slug.
//   The trailing slash matters: without it the site answers 301.
// - Host pinning: careers_url's host must be in ALLOWED_HOSTS (checked before
//   any request) and becomes the X-Origin value; the API host is a literal
//   (entry.api is not used). Every request passes redirect: 'error'.
// - Truncation: a max_pages / max_jobs stop, a page-2+ fetch error, or fewer
//   unique rows than pagination.total all set `jobs.truncated = true`.
// - detect(): branded domains — wire explicitly with `provider: directemployers`.

const API_URL = 'https://prod-search-api.jobsyn.org/api/v1/solr/search';
// Only sites verified to run on this platform; add a host after checking it live.
export const ALLOWED_HOSTS = new Set(['careers.alaskaair.com']);

const PAGE_SIZE = 10;
const DEFAULT_MAX_PAGES = 30; // 300 rows — Alaska Air Group is ~70
const MAX_PAGES_CAP = 300;
const DEFAULT_MAX_JOBS = 1000;
const MAX_JOBS_CAP = 3000;
const INTER_PAGE_DELAY_MS = 200;

/**
 * @param {any} entry
 * @returns {{origin: string, host: string}}
 */
export function resolveConfig(entry) {
  const raw = entry?.careers_url;
  if (typeof raw !== 'string' || !raw) throw new Error('directemployers: careers_url is required');
  const u = new URL(raw); // throws on malformed input
  if (u.protocol !== 'https:') throw new Error(`directemployers: refusing non-https URL ${u.protocol}`);
  if (u.username || u.password) throw new Error('directemployers: credentials in careers_url are not allowed');
  const host = u.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host) || (u.port && u.port !== '443')) {
    throw new Error(`directemployers: host ${u.host} is not in the allowlist (${[...ALLOWED_HOSTS].join(', ')})`);
  }
  return { origin: `https://${host}`, host };
}

/** @param {number} page 1-based */
export function buildSearchUrl(page) {
  return `${API_URL}?page=${page}`;
}

/**
 * Port of the site's slug function: NFD, strip combining marks and
 * `"’+:/`, then join the ASCII word runs with "-" in lower case.
 * "Seatac, WA" → "seatac-wa".
 * @param {unknown} s
 */
export function slugify(s) {
  if (typeof s !== 'string') return '';
  const cleaned = s.normalize('NFD').replace(/["̀-ͯ]/g, '').replace(/["’+:/]/g, '');
  return (cleaned.match(/\w+/g) || []).map((w) => w.toLowerCase()).join('-');
}

/** @param {unknown} value */
function toEpochMs(value) {
  if (typeof value !== 'string' || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** @param {unknown} v */
function str(v) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Build the public posting URL for one API row, or null when the row lacks a
 * usable guid / title slug / location slug.
 * @param {any} r @param {{origin: string}} cfg
 */
export function buildJobUrl(r, cfg) {
  const guid = typeof r?.guid === 'string' ? r.guid.trim() : '';
  if (!/^[0-9a-f]{32}$/i.test(guid)) return null;
  let titleSlug = typeof r.title_slug === 'string' ? r.title_slug.trim() : '';
  if (!/^[a-z0-9-]+$/.test(titleSlug)) titleSlug = slugify(r.title_exact);
  const locSlug = slugify(r.location_exact) || slugify(r.country_short_exact);
  if (!titleSlug || !locSlug) return null;
  return `${cfg.origin}/${locSlug}/${titleSlug}/${guid}/job/`;
}

/**
 * Parse one search response.
 * - null / {} → empty (endpoint alive, nothing to read)
 * - an object without a `jobs` array (or a non-object) → throw, naming the keys
 * - total > 0 on page 1 but no usable rows → throw (shape changed)
 * @param {unknown} body @param {{origin: string}} cfg @param {number} [page]
 * @returns {{rows: Array<{id: string, title: string, url: string, location: string, requisitionId?: string, postedAt?: number, description?: string}>, total: number|null, hasMore: boolean|null, rawCount: number}}
 */
export function parseSearch(body, cfg, page = 1) {
  if (body === null || body === undefined) return { rows: [], total: null, hasMore: false, rawCount: 0 };
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`directemployers: unexpected search response (${Array.isArray(body) ? 'array' : typeof body})`);
  }
  const data = /** @type {any} */ (body);
  if (Object.keys(data).length === 0) return { rows: [], total: null, hasMore: false, rawCount: 0 };
  if (!Array.isArray(data.jobs)) {
    throw new Error(`directemployers: unexpected search response (no jobs array; keys: ${Object.keys(data).slice(0, 10).join(', ')})`);
  }
  const pg = data.pagination && typeof data.pagination === 'object' ? data.pagination : {};
  const total = Number.isInteger(pg.total) && pg.total >= 0 ? pg.total : null;
  const hasMore = typeof pg.has_more_pages === 'boolean' ? pg.has_more_pages : null;
  const featured = Array.isArray(data.featured_jobs) ? data.featured_jobs : [];
  const raw = [...data.jobs, ...featured];
  const rows = [];
  const seen = new Set();
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const title = str(r.title_exact) || str(r.title);
    const url = buildJobUrl(r, cfg);
    if (!title || !url) continue;
    const id = r.guid.trim().toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);
    const row = { id, title, url, location: str(r.location_exact) };
    const reqid = str(r.reqid);
    if (reqid) row.requisitionId = reqid;
    const postedAt = toEpochMs(r.date_new) ?? toEpochMs(r.date_added);
    if (postedAt !== undefined) row.postedAt = postedAt;
    if (typeof r.description === 'string' && r.description.trim()) row.description = r.description;
    rows.push(row);
  }
  if (page === 1 && rows.length === 0 && (total ?? raw.length) > 0) {
    throw new Error(`directemployers: search reports ${total ?? raw.length} jobs but no job rows parsed (${raw.length} raw rows; shape changed?)`);
  }
  return { rows, total, hasMore, rawCount: data.jobs.length };
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

function resolveMaxJobs(entry) {
  const v = entry?.max_jobs;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_JOBS_CAP);
  return DEFAULT_MAX_JOBS;
}

/** @type {Provider} */
export default {
  id: 'directemployers',

  detect() {
    return null; // branded hosts — explicit `provider: directemployers` only
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry); // throws before any request on a bad URL
    const reqOpts = { redirect: 'error', headers: { accept: 'application/json', 'x-origin': cfg.host } };

    const ctxMaxPages = Number(ctx?.maxPages);
    const probing = ctxMaxPages > 0;
    const maxPages = resolveMaxPages(entry);
    const pagesToFetch = Math.min(maxPages, probing ? ctxMaxPages : Infinity);
    const maxJobs = resolveMaxJobs(entry);

    const jobs = [];
    const seen = new Set();
    let total = null;
    let stopReason = 'end';
    for (let page = 1; page <= pagesToFetch; page++) {
      if (page > 1) await sleep(INTER_PAGE_DELAY_MS, ctx);
      let body;
      try {
        body = await fetchJsonWithRetry(ctx, buildSearchUrl(page), reqOpts);
      } catch (err) {
        if (probing || page === 1) throw err; // unwrapped: probe budget identity must survive
        console.error(`⚠️  directemployers: ${entry.name} page ${page} failed (${err?.message}) — keeping ${jobs.length} postings`);
        stopReason = 'error';
        break;
      }
      const parsed = parseSearch(body, cfg, page);
      if (total === null) total = parsed.total;
      let fresh = 0;
      for (const row of parsed.rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        fresh++;
        /** @type {any} */
        const job = { title: row.title, url: row.url, company: entry.name, location: row.location };
        if (row.requisitionId) job.requisitionId = row.requisitionId;
        if (typeof row.postedAt === 'number') job.postedAt = row.postedAt;
        if (row.description) job.description = row.description;
        jobs.push(job);
      }
      if (jobs.length >= maxJobs) {
        if (jobs.length > maxJobs || parsed.hasMore === true || (total !== null && total > maxJobs)) stopReason = 'max_jobs';
        break;
      }
      if (parsed.rawCount === 0 || fresh === 0) {
        // The site says more pages exist but this one added nothing: the read is incomplete.
        if (parsed.hasMore === true) stopReason = 'stalled';
        break;
      }
      if (parsed.hasMore === false) break;
      if (total !== null && (jobs.length >= total || page * PAGE_SIZE >= total)) break;
      if (page === pagesToFetch) stopReason = probing ? 'probe' : 'max_pages';
    }

    const out = jobs.slice(0, maxJobs);
    const short = total !== null && out.length < total;
    if ((stopReason === 'max_pages' || stopReason === 'max_jobs') && total !== null) {
      console.error(`⚠️  directemployers: ${entry.name} truncated at ${out.length} of ${total} postings — raise max_pages/max_jobs on this entry for more`);
    } else if (short && (stopReason === 'end' || stopReason === 'stalled')) {
      console.error(`⚠️  directemployers: ${entry.name} read ${out.length} unique postings but the site reports ${total}`);
    }
    // The caller reads `truncated` to report the board as incomplete: a cap cut
    // valid rows, a later page failed, or fewer unique rows than the site's total.
    if (stopReason === 'stalled') console.error(`⚠️  directemployers: ${entry.name} truncated — a page added no postings while the site reports more pages (${out.length} kept)`);
    if (stopReason === 'max_pages' || stopReason === 'max_jobs' || stopReason === 'error' || stopReason === 'stalled' || short) {
      /** @type {any} */ (out).truncated = true;
    }
    return out;
  },
};
