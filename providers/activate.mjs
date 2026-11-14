// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchJsonWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';

// "Activate" career-site provider (→ tracked_companies:).
//
// Activate is a hosted career-site platform served on the employer's own
// domain (Ross Stores: jobs.rossstores.com — the page body carries
// `<div class="Band Title Activate SearchJobs">` and its assets come from
// activatecdn.azureedge.net). Its search page is a jQuery jTable whose
// listAction (ReusableComponents/JobSearchResultsTable/JobSearchResultsTable.js,
// read live 2026-11-07) is a plain GET against the same origin:
//
//   GET {origin}/Search/SearchResults?{search-page query}&jtStartIndex=N&jtPageSize=M
//   → {"Result":"OK","TotalRecordCount":7205,
//      "Records":[{"ID":"39b4d358-…","Title":"<span>Store Manager</span>",
//                  "CityStateDataAbbrev":"<span>Oklahoma City, OK</span>",
//                  "CountryName":"<span>United States</span>",
//                  "PostedDateRaw":"2026-11-07T00:00:00",
//                  "TrackingObject":{"TitleJson":"Store Manager",…},…}]}
//   jTable's own error envelope is {"Result":"ERROR","Message":"…"}.
//   Sending `Accept: application/json` makes the server double-encode the
//   body (a JSON string containing the JSON) — we send no Accept override.
//
// - The posting page is `/search/jobdetails/{slug}/{ID}`, slug built exactly as
//   the site's core.common.convertToSlug() does (a wrong slug 302s to the
//   right one, so the ID is what matters; the slug keeps the URL canonical).
// - The search page's own query string (Keyword, CategoryID, CountryOnly, …)
//   is forwarded unchanged, the way the page does it; jt* paging params are ours.
// - Branded domains: no URL-pattern detect(). Wire up with an explicit
//   `provider: activate`. Only the careers_url host is ever fetched, https only,
//   no redirects followed.
// - Offset paging is NOT stable on this backend: walking Ross in 500-row
//   pages returned 7,205 rows but only 6,005 distinct IDs (default order; also
//   with jtSorting=ReferenceNumber/PostedDate — ties reshuffle between calls,
//   and jtSorting=ID is a 500). So we do two requests: a 1-row probe for
//   TotalRecordCount, then the whole list in one jtPageSize=total call
//   (Ross: 7,205 rows, 12.9 MB raw / 1.8 MB gzip, ~2 s). The row count is
//   capped by max_jobs (default 10,000, hard ceiling 25,000), never by the
//   server's own total alone.
//
// portals.yml:
//   - name: Ross Stores
//     provider: activate
//     careers_url: https://jobs.rossstores.com/search/searchjobs

const PROBE_ROWS = 1;
const DEFAULT_MAX_JOBS = 10_000; // Ross is ~7,200
const MAX_JOBS_CAP = 25_000;
const HEALTH_PROBE_ROWS = 100; // ctx.maxPages (health probe): one small request only
const SLACK_ROWS = 50; // postings added between the two requests
const TIMEOUT_MS = 60_000;

const PAGING_PARAMS = new Set(['jtstartindex', 'jtpagesize', 'jtsorting']);

/** Hosts known to run the Activate platform. Add a tenant here after checking it live. */
export const ALLOWED_HOSTS = new Set(['jobs.rossstores.com']);

/**
 * Validate careers_url and derive origin + forwarded query.
 * Throws on malformed URL, non-https, credentials, or an IP/localhost host.
 * @param {any} entry
 */
export function resolveConfig(entry) {
  const raw = entry?.api || entry?.careers_url;
  if (typeof raw !== 'string' || !raw) throw new Error('activate: careers_url is required');
  const u = new URL(raw);
  if (u.protocol !== 'https:') throw new Error(`activate: refusing non-https URL ${u.protocol}`);
  if (u.username || u.password) throw new Error('activate: credentials in URL are not allowed');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || /^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) {
    throw new Error(`activate: host not allowed: ${host}`);
  }
  if (u.port) throw new Error('activate: explicit ports are not allowed');
  if (!ALLOWED_HOSTS.has(host)) throw new Error(`activate: host not in allowlist: ${host}`);
  const query = new URLSearchParams();
  for (const [k, v] of u.searchParams) {
    if (!PAGING_PARAMS.has(k.toLowerCase())) query.append(k, v);
  }
  return { origin: `https://${host}`, host, query };
}

/** @param {{origin:string, query:URLSearchParams}} cfg @param {number} start @param {number} size */
export function buildSearchUrl(cfg, start, size) {
  const q = new URLSearchParams(cfg.query);
  q.set('jtStartIndex', String(start));
  q.set('jtPageSize', String(size));
  return `${cfg.origin}/Search/SearchResults?${q.toString()}`;
}

/** Mirror of the site's core.common.convertToSlug(). @param {string} title */
export function toSlug(title) {
  return title.toLowerCase().replace(/ /g, '-').replace(/[^a-zA-Z0-9_㐀-龿\s-]/g, '');
}

/** @param {unknown} s */
function clean(s) {
  return typeof s === 'string' ? decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
}

/** ISO-ish date (no zone → UTC) → epoch ms, NaN-safe. @param {unknown} v */
export function toEpochMs(v) {
  if (!v || typeof v !== 'string') return undefined;
  const s = /[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}Z`;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? undefined : ms;
}

const ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Parse one SearchResults page.
 * - jTable error envelope (Result !== "OK") → throw with its Message
 * - missing / non-array Records, or an unrecognised object → throw
 * - Records: [] → genuine empty page
 * @param {any} json
 * @param {string} origin
 */
export function parseSearchResponse(json, origin) {
  // With `Accept: application/json` the endpoint answers a JSON *string* that
  // itself holds the JSON object (verified live) — so we don't send that header,
  // and unwrap one level here if a proxy/CDN ever brings it back.
  if (typeof json === 'string' && /^\s*\{/.test(json)) {
    try {
      json = JSON.parse(json);
    } catch {
      throw new Error('activate: SearchResults body is a string that is not JSON');
    }
  }
  if (json == null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(`activate: unexpected SearchResults body (${json === null ? 'null' : Array.isArray(json) ? 'array' : typeof json})`);
  }
  const keys = Object.keys(json);
  if (!('Result' in json)) throw new Error(`activate: unexpected SearchResults shape (keys: ${keys.slice(0, 8).join(', ') || 'none'})`);
  if (json.Result !== 'OK') {
    const msg = typeof json.Message === 'string' ? json.Message : '';
    throw new Error(`activate: search returned Result=${String(json.Result)}${msg ? `: ${msg}` : ''}`);
  }
  if (!Array.isArray(json.Records)) throw new Error('activate: unexpected SearchResults (Records is not an array)');
  const total = Number.isInteger(json.TotalRecordCount) && json.TotalRecordCount >= 0 ? json.TotalRecordCount : null;
  const rows = [];
  for (const rec of json.Records) {
    if (!rec || typeof rec !== 'object') continue;
    if (typeof rec.ID !== 'string' || !ID_RE.test(rec.ID)) continue;
    const plainTitle = typeof rec.TrackingObject?.TitleJson === 'string' ? rec.TrackingObject.TitleJson.trim() : '';
    const title = clean(rec.Title) || decodeEntities(plainTitle);
    if (!title) continue;
    const slug = toSlug(plainTitle || title) || 'job';
    const cityState = clean(rec.CityStateDataAbbrev) || clean(rec.CityStateData);
    const country = clean(rec.CountryName);
    const location = [cityState, country].filter(Boolean).join(', ');
    rows.push({
      id: rec.ID.toLowerCase(),
      title,
      url: `${origin}/search/jobdetails/${safeEncodeURIComponent(slug)}/${rec.ID}`,
      location,
      postedAt: toEpochMs(rec.PostedDateRaw),
    });
  }
  return { rows, rawCount: json.Records.length, total };
}

function resolveMaxJobs(entry) {
  const v = entry?.max_jobs;
  return Number.isInteger(v) && v > 0 ? Math.min(v, MAX_JOBS_CAP) : DEFAULT_MAX_JOBS;
}

// Single-page response cap (see fetch).
const ACTIVATE_MAX_BYTES = 64 * 1024 * 1024;

/** @type {Provider} */
export default {
  id: 'activate',

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry); // throws before any request
    // The whole board comes back in one response (Ross Stores: ~7,200 rows, over the shared 10 MB
    // default from upstream 1.40), so this provider sets its own bounded ceiling.
    const reqOpts = { redirect: 'error', timeoutMs: TIMEOUT_MS, maxBytes: ACTIVATE_MAX_BYTES, headers: { 'x-requested-with': 'XMLHttpRequest' } };
    const probing = Number(ctx?.maxPages) > 0;
    const maxJobs = resolveMaxJobs(entry);

    let size;
    let total = null;
    if (probing) {
      size = HEALTH_PROBE_ROWS;
    } else {
      const head = parseSearchResponse(await fetchJsonWithRetry(ctx, buildSearchUrl(cfg, 0, PROBE_ROWS), reqOpts), cfg.origin);
      total = head.total;
      if (total === 0 || (total === null && head.rawCount === 0)) return [];
      if (total === null) throw new Error('activate: SearchResults has no TotalRecordCount — cannot size the single-page request');
      size = Math.min(total + SLACK_ROWS, maxJobs);
      await sleep(250, ctx);
    }

    const parsed = parseSearchResponse(await fetchJsonWithRetry(ctx, buildSearchUrl(cfg, 0, size), reqOpts), cfg.origin);
    const jobs = [];
    const seen = new Set();
    for (const row of parsed.rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const job = { title: row.title, url: row.url, company: entry.name, location: row.location };
      if (typeof row.postedAt === 'number') job.postedAt = row.postedAt;
      jobs.push(job);
      if (jobs.length >= maxJobs) break;
    }
    if (!probing && total !== null && total > 0 && parsed.rawCount === 0) {
      throw new Error(`activate: SearchResults reported ${total} postings but returned none`);
    }
    const expected = total !== null ? Math.min(total, maxJobs) : null;
    if (!probing && expected !== null && expected > 0 && parsed.rawCount < expected * 0.95) {
      console.error(`⚠️  activate: ${entry.name} returned only ${parsed.rawCount} of ${total} reported postings — server may cap response size; results incomplete`);
    }
    if (!probing && total !== null && total > maxJobs) {
      console.error(`⚠️  activate: ${entry.name} truncated at ${jobs.length} of ${total} postings — raise max_jobs on this entry (ceiling ${MAX_JOBS_CAP})`);
    }
    return jobs;
  },
};
