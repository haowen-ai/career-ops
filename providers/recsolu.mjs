// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchJsonWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

// Recsolu (Yello) job-board provider (→ tracked_companies:).
//
// careers_url shape: https://{tenant}.recsolu.com/job_boards/{boardId}
//   e.g. https://kearney.recsolu.com/job_boards/1
//
// The board page is server-rendered (first 25 rows) and pages further with an
// infinite-scroll XHR. Verified live 2026-11-07 by reading job_boards-*.js
// (buildRequisitionSearchUrl / scrollNextPage) and replaying it:
//
//   GET https://{tenant}.recsolu.com/job_boards/{boardId}/search
//         ?query=&filters=<comma-separated filter answer ids>&page_number=<1-based>
//   accept: application/json
//   → {"html":"<li class=\"search-results__item\">…<a class=\"search-results__req_title\"
//        href=\"/jobs/{slug}?job_board_id={board slug}\">Title</a>
//        <div><span>Full-time</span><span>Americas</span><span>Chicago</span></div>
//        …<div class=\"search-results__post-time pull-right\">1w</div>…</li>…",
//      "count_on_page":25,"more_requisitions":true,"query":"","filters":"[…]",…}
//   The page size is fixed at 25; past the end count_on_page is 0 and
//   more_requisitions false. The numeric board id and the board's slug id both
//   work in the path; an unknown board answers 404 JSON.
//
// Filters: filter-answer ids are per tenant and are listed in the board page
// sidebar (Kearney: Organization → "United States" = 12240). Set them with
// `filters: "12240"` on the entry or `?filters=12240` on careers_url (entry
// key wins). Postings carry no country, so a US view needs the filter.
//
// Location = the row's <span>s after the first (the first is the job type).
// Post time is relative ("NEW", "3d", "2w") or "Oct 9" (year inferred).
// Host pinned to *.recsolu.com; all requests go to the careers_url origin.

const HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.recsolu\.com$/;
const BOARD_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PAGE_SIZE = 25; // fixed by the server
const DEFAULT_MAX_PAGES = 40;
const MAX_PAGES_CAP = 200;
const INTER_PAGE_DELAY_MS = 200;
const DAY_MS = 86_400_000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Validate careers_url and derive {origin, board, filters}.
 * @param {any} entry
 */
export function resolveConfig(entry) {
  const raw = entry?.careers_url || entry?.api;
  if (typeof raw !== 'string' || !raw) throw new Error('recsolu: careers_url is required');
  const u = new URL(raw); // throws on malformed input
  if (u.protocol !== 'https:') throw new Error(`recsolu: refusing non-https URL ${u.protocol}`);
  const host = u.hostname.toLowerCase();
  if (!HOST_RE.test(host) || host.startsWith('assets.')) throw new Error(`recsolu: host not allowed: ${u.hostname}`);
  const m = u.pathname.match(/^\/job_boards\/([^/]+)\/?/);
  if (!m || !BOARD_RE.test(m[1])) throw new Error(`recsolu: careers_url must be /job_boards/{id}, got ${u.pathname}`);
  let rawFilters = entry?.filters;
  if (Array.isArray(rawFilters)) rawFilters = rawFilters.join(',');
  if (typeof rawFilters === 'number') rawFilters = String(rawFilters);
  if (typeof rawFilters !== 'string') rawFilters = u.searchParams.get('filters') || '';
  const filters = rawFilters.split(',').map((s) => s.trim()).filter(Boolean);
  if (filters.some((f) => !/^\d{1,10}$/.test(f))) throw new Error(`recsolu: filters must be numeric ids, got "${rawFilters}"`);
  return { origin: `https://${host}`, board: m[1], filters: filters.join(',') };
}

/** @param {{origin:string, board:string, filters:string}} cfg @param {number} page 1-based */
export function buildSearchUrl(cfg, page) {
  const q = new URLSearchParams({ query: '', filters: cfg.filters, page_number: String(page) });
  return `${cfg.origin}/job_boards/${cfg.board}/search?${q.toString()}`;
}

/**
 * "NEW" | "3d" | "2w" | "5h" | "Oct 9" → epoch ms (UTC day), else undefined.
 * @param {unknown} raw @param {number} now
 */
export function parsePostTime(raw, now) {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim().toLowerCase();
  if (!s) return undefined;
  if (s === 'new' || s === 'today') return now;
  let m = s.match(/^(\d{1,3})\s*([hdwm])$/);
  if (m) {
    const n = Number(m[1]);
    const unit = { h: DAY_MS / 24, d: DAY_MS, w: 7 * DAY_MS, m: 30 * DAY_MS }[m[2]];
    return now - n * unit;
  }
  m = s.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/);
  if (m) {
    const mon = MONTHS.indexOf(m[1]);
    const day = Number(m[2]);
    if (mon < 0 || day < 1 || day > 31) return undefined;
    let year = m[3] ? Number(m[3]) : new Date(now).getUTCFullYear();
    let ms = Date.UTC(year, mon, day);
    if (!m[3] && ms > now + 2 * DAY_MS) ms = Date.UTC(--year, mon, day);
    return new Date(ms).getUTCDate() === day ? ms : undefined;
  }
  return undefined;
}

/** @param {string} s */
function text(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Parse the rows out of one search payload's html fragment.
 * @param {string} html @param {{origin:string}} cfg @param {number} now
 */
export function parseRowsHtml(html, cfg, now) {
  const chunks = html.split(/<li\b[^>]*class="[^"]*\bsearch-results__item\b[^"]*"[^>]*>/).slice(1);
  const rows = [];
  for (const chunk of chunks) {
    const a = chunk.match(/<a\b[^>]*class="[^"]*\bsearch-results__req_title\b[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const href = (a[0].match(/\bhref="([^"]*)"/) || [])[1];
    if (!href) continue;
    const hm = decodeEntities(href).match(/^\/jobs\/([^/?#]+)(?=$|[?#])(?:\?job_board_id=([^&#]+))?/);
    if (!hm || !SLUG_RE.test(hm[1])) continue;
    const title = text(a[1]);
    if (!title) continue;
    const board = hm[2] && SLUG_RE.test(hm[2]) ? `?job_board_id=${hm[2]}` : '';
    const after = chunk.slice(chunk.indexOf(a[0]) + a[0].length);
    const infoDiv = after.match(/^\s*<div>([\s\S]*?)<\/div>/);
    const spans = infoDiv ? [...infoDiv[1].matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/g)].map((x) => text(x[1])).filter(Boolean) : [];
    const post = chunk.match(/class="[^"]*\bsearch-results__post-time\b[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    rows.push({
      id: hm[1],
      title,
      url: `${cfg.origin}/jobs/${hm[1]}${board}`,
      location: spans.length >= 2 ? spans.slice(1).join(', ') : '',
      postedAt: post ? parsePostTime(text(post[1]), now) : undefined,
    });
  }
  return { rows, rawCount: chunks.length };
}

/**
 * Validate one search response and parse it. Throws on any unexpected shape.
 * @param {any} json @param {{origin:string}} cfg @param {number} now
 */
export function parseSearchResponse(json, cfg, now) {
  if (json == null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(`recsolu: unexpected search response (${Array.isArray(json) ? 'array' : typeof json})`);
  }
  if (typeof json.html !== 'string' || !Number.isInteger(json.count_on_page) || json.count_on_page < 0) {
    const keys = Object.keys(json);
    const detail = typeof json.error === 'string' ? ` — ${json.error}` : '';
    throw new Error(`recsolu: unexpected search response shape (keys: ${keys.slice(0, 8).join(', ') || 'none'})${detail}`);
  }
  const { rows, rawCount } = parseRowsHtml(json.html, cfg, now);
  if (json.count_on_page > 0 && rawCount === 0) {
    throw new Error(`recsolu: count_on_page=${json.count_on_page} but no search-results__item rows in html (markup changed?)`);
  }
  return { rows, count: json.count_on_page, more: json.more_requisitions === true };
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

/** @type {Provider} */
export default {
  id: 'recsolu',

  detect(entry) {
    try {
      const raw = entry?.careers_url || entry?.api;
      if (typeof raw !== 'string') return null;
      resolveConfig({ careers_url: raw });
      return { url: raw };
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry); // throws before any request
    const now = typeof ctx?.now === 'function' ? ctx.now() : Date.now();
    const reqOpts = { redirect: 'error', headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' } };

    const ctxMaxPages = Number(ctx?.maxPages);
    const probing = ctxMaxPages > 0;
    const pagesToFetch = Math.min(resolveMaxPages(entry), probing ? ctxMaxPages : Infinity);

    const jobs = [];
    const seen = new Set();
    let stopReason = 'end';
    for (let page = 1; page <= pagesToFetch; page++) {
      if (page > 1) await sleep(INTER_PAGE_DELAY_MS, ctx);
      let json;
      try {
        json = await fetchJsonWithRetry(ctx, buildSearchUrl(cfg, page), reqOpts);
      } catch (err) {
        if (probing || page === 1) throw err; // unwrapped for the probe budget
        throw new Error(`recsolu: ${entry?.name} page ${page} failed (${err?.message}) after ${jobs.length} postings`);
      }
      const parsed = parseSearchResponse(json, cfg, now);
      if (parsed.count === 0) break;
      let fresh = 0;
      for (const row of parsed.rows) {
        if (seen.has(row.url)) continue;
        seen.add(row.url);
        fresh++;
        const job = { title: row.title, url: row.url, company: entry.name, location: row.location };
        if (typeof row.postedAt === 'number') job.postedAt = row.postedAt;
        jobs.push(job);
      }
      if (!parsed.more || parsed.count < PAGE_SIZE || fresh === 0) break;
      if (page === pagesToFetch) stopReason = probing ? 'probe' : 'max_pages';
    }
    if (stopReason === 'max_pages') {
      console.error(`⚠️  recsolu: ${entry?.name} stopped at ${pagesToFetch} pages — raise max_pages on this entry for more`);
    }
    return jobs;
  },
};
