// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchJsonWithRetry, fetchTextWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

// Graphic Packaging International career site provider (→ tracked_companies:).
//
// careers.graphicpkg.com is a custom career site (it replaced the public
// SuccessFactors board; applications still go to career55.sapsf.eu). Its own
// https://careers.graphicpkg.com/llms.txt documents a public, no-auth JSON API
// (verified live 2026-11-11):
//
//   GET /api/mcp/jobs?tool=search_jobs&page={1-based}&pageSize={n}
//   → {"tool":"search_jobs","totalCount":262,"page":1,"pageSize":500,
//      "summary":"Found 262 jobs","results":[{"requisitionId":"14329",
//      "title":"Press Operator Assistant","department":"Manufacturing & Operations",
//      "location":"Staunton, VA, USA","employmentType":"Standard",
//      "datePosted":"2026-04-29","applyUrl":"https://career55.sapsf.eu/…",
//      "description":"<first ~300 chars>"}, …]}
//
// - The whole board is ~260 jobs, so it is read in full (no keyword mode; the
//   API's `search` is full-text and matches "intern" inside "International" in
//   almost every posting). pageSize is honoured up to at least 1000; one 500-row
//   page holds the board today. Pages of one size come from one CDN cache entry,
//   so a single large page also avoids rows shifting between page requests
//   (totalCount was seen to differ by one between pageSize keys).
// - The list carries no posting URL. Postings are server-rendered at
//   /job/{departmentId}/{title-slug}/{City-State}/career55rms/{requisitionId}
//   (200), and every one is listed in /sitemap.xml. Any /job/{requisitionId}
//   (or wrong slug) answers 308 to that canonical path. So the provider reads
//   the sitemap once and maps requisitionId → canonical URL; a posting not yet
//   in the sitemap (or a failed sitemap read) falls back to the short
//   /job/{requisitionId} form, which still lands on the posting.
// - Host pinning: careers_url/api, when given, must be https on HOST; every
//   request goes to the fixed ORIGIN and never follows a redirect.
// - `truncated` is set when the page cap stops the walk or the walk yields
//   fewer unique rows than the API's totalCount.
// - detect(): branded domain — wire explicitly with `provider: graphicpkg`.

export const HOST = 'careers.graphicpkg.com';
const ORIGIN = `https://${HOST}`;
export const PAGE_SIZE = 500;
const DEFAULT_MAX_PAGES = 4; // 2000 rows — the board is ~260
const MAX_PAGES_CAP = 40;
const INTER_PAGE_DELAY_MS = 200;
const CANONICAL_JOB_PATH = /^\/job\/\d+\/[^/]+\/[^/]+\/[^/]+\/(\d+)\/?$/;

/**
 * Validate the entry's URL (if any) against the host allowlist. Throws before
 * any request on a foreign host, non-https, credentials or a malformed URL.
 * @param {any} entry
 * @returns {{origin: string}}
 */
export function resolveConfig(entry) {
  const raw = entry?.careers_url || entry?.api;
  if (raw === undefined || raw === null || raw === '') return { origin: ORIGIN };
  if (typeof raw !== 'string') throw new Error('graphicpkg: careers_url must be a string');
  const u = new URL(raw); // throws on malformed input
  if (u.protocol !== 'https:') throw new Error(`graphicpkg: refusing non-https URL ${u.protocol}`);
  if (u.username || u.password) throw new Error('graphicpkg: credentials in careers_url are not allowed');
  if (u.hostname.toLowerCase() !== HOST || (u.port && u.port !== '443')) {
    throw new Error(`graphicpkg: host ${u.host} is not in the allowlist (${HOST})`);
  }
  return { origin: ORIGIN };
}

/** @param {number} page */
export function buildSearchUrl(page) {
  const q = new URLSearchParams({ tool: 'search_jobs', page: String(page), pageSize: String(PAGE_SIZE) });
  return `${ORIGIN}/api/mcp/jobs?${q.toString()}`;
}

export const SITEMAP_URL = `${ORIGIN}/sitemap.xml`;

/**
 * Short posting URL; the site 308s it to the canonical page. Only an
 * all-digit requisitionId (as parseSearch() admits) is accepted, so the path
 * segment needs no encoding.
 * @param {string} id
 */
export function fallbackJobUrl(id) {
  return /^\d+$/.test(id) ? `${ORIGIN}/job/${id}` : null;
}

/**
 * requisitionId → canonical posting URL from sitemap.xml. Only https links on
 * HOST with the canonical job path are kept. A non-string body → empty map.
 * @param {unknown} xml
 * @returns {Map<string, string>}
 */
export function parseSitemap(xml) {
  const map = new Map();
  if (typeof xml !== 'string') return map;
  for (const m of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
    let u;
    try {
      u = new URL(decodeEntities(m[1]));
    } catch {
      continue;
    }
    if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== HOST || u.search) continue;
    const id = CANONICAL_JOB_PATH.exec(u.pathname)?.[1];
    if (id && !map.has(id)) map.set(id, `${ORIGIN}${u.pathname}`);
  }
  return map;
}

/** YYYY-MM-DD or ISO → epoch ms, NaN-safe. @param {unknown} value */
export function toEpochMs(value) {
  if (!value || typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** @param {unknown} s */
function clean(s) {
  return typeof s === 'string' ? decodeEntities(s).replace(/\s+/g, ' ').trim() : '';
}

/**
 * Parse one search_jobs page.
 * - null / {} / {results: null} → no rows (empty board)
 * - an object without a results array, or results not an array → throw
 * - totalCount > 0 and this page has results but none parse → throw
 * Rows need a numeric requisitionId and a title.
 * @param {unknown} body
 * @returns {{rows: {id: string, title: string, location: string, postedAt?: number}[], total: number|null, rawCount: number}}
 */
export function parseSearch(body) {
  let data = body;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { throw new Error(`graphicpkg: search_jobs response is not JSON (${data.length} bytes)`); }
  }
  if (data === null || data === undefined) return { rows: [], total: null, rawCount: 0 };
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`graphicpkg: unexpected search_jobs response (${Array.isArray(data) ? 'array' : typeof data})`);
  }
  const keys = Object.keys(data);
  if (keys.length === 0 || data.results === null) return { rows: [], total: null, rawCount: 0 };
  if (!Array.isArray(data.results)) {
    throw new Error(`graphicpkg: unexpected search_jobs response (no results array; keys: ${keys.slice(0, 8).join(', ')})`);
  }
  const total = Number.isInteger(data.totalCount) && data.totalCount >= 0 ? data.totalCount : null;
  const rows = [];
  for (const r of data.results) {
    if (!r || typeof r !== 'object') continue;
    const id = String(r.requisitionId ?? '').trim();
    const title = clean(r.title);
    if (!/^\d+$/.test(id) || !title) continue;
    const row = { id, title, location: clean(r.location) };
    const postedAt = toEpochMs(r.datePosted);
    if (postedAt !== undefined) row.postedAt = postedAt;
    rows.push(row);
  }
  if (rows.length === 0 && data.results.length > 0) {
    throw new Error(`graphicpkg: search_jobs page has ${data.results.length} results but no job rows parsed (shape changed?)`);
  }
  return { rows, total, rawCount: data.results.length };
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

/** @type {Provider} */
export default {
  id: 'graphicpkg',

  detect() {
    return null; // branded host — explicit `provider: graphicpkg` only
  },

  async fetch(entry, ctx) {
    resolveConfig(entry); // throws before any request on a bad URL
    const ctxMaxPages = Number(ctx?.maxPages);
    const probing = ctxMaxPages > 0;
    const maxPages = resolveMaxPages(entry);
    const pagesToFetch = Math.min(maxPages, probing ? ctxMaxPages : Infinity);
    const reqOpts = { redirect: 'error', headers: { accept: 'application/json' }, timeoutMs: 30_000 };

    /** @type {{id: string, title: string, location: string, postedAt?: number}[]} */
    const rows = [];
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
        console.error(`⚠️  graphicpkg: ${entry.name} page ${page} failed (${err?.message}) — keeping ${rows.length} postings`);
        stopReason = 'error';
        break;
      }
      const parsed = parseSearch(body);
      if (total === null) total = parsed.total;
      if (parsed.rawCount === 0) break;
      let fresh = 0;
      for (const row of parsed.rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        fresh++;
        rows.push(row);
      }
      if (fresh === 0) break;
      if (total !== null && rows.length >= total) break;
      if (parsed.rawCount < PAGE_SIZE) break;
      if (page === pagesToFetch) stopReason = probing ? 'probe' : 'max_pages';
    }

    // Canonical posting URLs from the sitemap (skipped during a health probe).
    let canonical = new Map();
    if (!probing && rows.length) {
      try {
        canonical = parseSitemap(await fetchTextWithRetry(ctx, SITEMAP_URL, { redirect: 'error', headers: { accept: 'application/xml' }, timeoutMs: 30_000 }));
      } catch (err) {
        console.error(`⚠️  graphicpkg: ${entry.name} sitemap failed (${err?.message}) — using /job/{id} links`);
      }
    }

    const out = [];
    for (const row of rows) {
      const url = canonical.get(row.id) || fallbackJobUrl(row.id);
      if (!url) continue;
      const job = { title: row.title, url, company: entry.name, location: row.location };
      if (typeof row.postedAt === 'number') job.postedAt = row.postedAt;
      out.push(job);
    }

    if (stopReason === 'max_pages' && total !== null && out.length < total) {
      console.error(`⚠️  graphicpkg: ${entry.name} truncated at ${out.length} of ${total} postings — raise max_pages on this entry for more`);
    }
    // The caller reads `truncated` to report the board as incomplete: the page cap
    // stopped the walk, or fewer unique rows came back than the API says it has.
    if (stopReason === 'max_pages' || stopReason === 'error' || (!probing && total !== null && out.length < total)) {
      /** @type {any} */ (out).truncated = true;
    }
    return out;
  },
};
