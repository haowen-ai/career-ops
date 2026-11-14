// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchJsonWithRetry, fetchTextWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';
import { htmlToText } from './_html-to-text.mjs';

// Oracle Taleo Enterprise career-section provider (→ tracked_companies:).
//
// One generic adapter for every `<tenant>.taleo.net/careersection/<code>/…`
// board. Both the "faceted" jobsearch.ftl page and the older "basic" page are
// front ends over the same JSON endpoint (verified live 2026-11-07 against
// drhorton, valero, epco, vsco, lbrands, equitable, tas-hyatt, cognizant):
//
//   POST https://<tenant>.taleo.net/careersection/rest/jobboard/searchjobs
//        ?lang=en&portalCode=<code>
//   headers: content-type: application/json, tz: GMT-05:00
//            (without a `tz` header some tenants answer 500 "An Error
//             Occurred in TEE")
//   body: {"multilineEnabled":false,
//          "sortingSelection":{"sortBySelectionParam":"3","ascendingSortingOrder":"false"},
//          "fieldData":{"fields":{"KEYWORD":""},"valid":true},
//          "filterSelectionParam":{"searchFilterSelections":[{"id":"LOCATION","selectedValues":[…]}]},
//          "advancedSearchFiltersSelectionParam":{"searchFilterSelections":[]},
//          "pageNo":1}
//   → {"requisitionList":[{"jobId":"270741","contestNo":"2605650",
//        "column":["Purchasing Assistant-WA","[\"Washington-Vancouver\"]","Nov 5, 2026"],
//        "linkedColumn":0,"locationsColumns":[1]}, …],
//      "facetResults":[{"id":"LOCATION","facetValueResults":[{"id":"494100123295",
//        "text":"United States","quantity":"1341","level":1}, …]}, …],
//      "pagingData":{"currentPageNo":1,"pageSize":25,"totalCount":578},
//      "careerSectionUnAvailable":false}
//   An unknown career-section code answers 200 with
//   {"requisitionList":null,…,"careerSectionUnAvailable":true} — that throws.
//
// - `column` layout is per-section: `linkedColumn` is the title index,
//   `locationsColumns` the location indexes (each a JSON-encoded string
//   array); the posting date is whichever other column reads "Mon D, YYYY".
// - Page size is fixed by Taleo at 25. Pagination is bounded by our own page
//   ceiling; totalCount only shortens it.
// - US filter: when the first page's LOCATION facet carries a "United States"
//   value AND other locations exist, the walk restarts with that value
//   selected (one extra request). Disable with `us_only: false`. Skipped
//   during a health probe (ctx.maxPages) so the probe stays one request.
// - Job URL: https://<tenant>.taleo.net/careersection/<code>/jobdetail.ftl?job=<contestNo>&lang=en
//   (the requisition number; the internal jobId also works and is the fallback).
// - Host pinned to https://<single-label>.taleo.net; redirects refused.
// - careers_url query `keyword=` (if any) becomes the KEYWORD field.
// - tre.taleo.net (Taleo Business Edition) is a different product: refused.
// - Opt-in `fetchDetails: true` (upstream 1.40): a bounded prefix of postings
//   (`detailLimit`, default 25, max 100) gets its description from the public
//   detail page's JSON-LD JobPosting; skipped while probing; best-effort.
//
// Merge note (1.40.0-cj.1): upstream 1.40 ships its own taleo.mjs that first
// fetches the jobsearch.ftl shell for a numeric portal id and column headings,
// then POSTs `portal=<id>`. This fork's implementation (portalCode=<section>,
// no shell request, columns from linkedColumn/locationsColumns, US LOCATION
// facet refilter, max_pages truncation warning) is kept because it is verified
// live on every tracked tenant and has the US filter upstream lacks; upstream's
// detail enrichment is ported in.

const HOST_RE = /^[a-z0-9][a-z0-9-]{0,62}\.taleo\.net$/;
const SECTION_RE = /^[A-Za-z0-9_. -]{1,64}$/;
const JOB_ID_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const PAGE_SIZE = 25; // fixed server-side
const DEFAULT_MAX_PAGES = 100; // 2,500 rows
const MAX_PAGES_CAP = 400; // 10,000 rows, hard ceiling even for an override
const INTER_PAGE_DELAY_MS = 200;
const TIMEOUT_MS = 20_000;
const US_RE = /^(united states( of america)?|usa|u\.s\.a?\.?|us)$/i;
const TALEO_BUSINESS_EDITION_HOST = 'tre.taleo.net';
const DEFAULT_DETAIL_LIMIT = 25;
const MAX_DETAIL_LIMIT = 100;
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/**
 * Validate careers_url and derive {origin, section, keyword, usOnly}.
 * Throws on malformed URL, non-https, a host outside *.taleo.net, or a
 * missing career-section code — before any network call.
 * @param {any} entry
 */
export function resolveConfig(entry) {
  const raw = entry?.careers_url || entry?.api;
  if (typeof raw !== 'string' || !raw) throw new Error('taleo: careers_url is required');
  const u = new URL(raw); // throws on malformed input
  if (u.protocol !== 'https:') throw new Error(`taleo: refusing non-https URL ${u.protocol}`);
  const host = u.hostname.toLowerCase();
  if (!HOST_RE.test(host) || host === TALEO_BUSINESS_EDITION_HOST) throw new Error(`taleo: host not allowed: ${u.hostname}`);
  let section = typeof entry?.careersection === 'string' ? entry.careersection : '';
  if (!section) {
    const m = u.pathname.match(/^\/careersection\/([^/]+)\//);
    if (m) {
      try {
        section = decodeURIComponent(m[1].replace(/\+/g, ' '));
      } catch {
        section = m[1];
      }
    }
  }
  if (!section) section = u.searchParams.get('portalCode') || '';
  if (!SECTION_RE.test(section)) {
    throw new Error(`taleo: careers_url needs a career section (…/careersection/<code>/jobsearch.ftl), got ${JSON.stringify(section)}`);
  }
  return {
    origin: `https://${host}`,
    section,
    keyword: (u.searchParams.get('keyword') || '').trim(),
    usOnly: entry?.us_only !== false,
  };
}

/** @param {any} cfg */
export function buildSearchUrl(cfg) {
  const q = new URLSearchParams({ lang: 'en', portalCode: cfg.section });
  return `${cfg.origin}/careersection/rest/jobboard/searchjobs?${q.toString()}`;
}

/** @param {any} cfg @param {number} pageNo 1-based @param {string|null} locationId */
export function buildSearchBody(cfg, pageNo, locationId) {
  return JSON.stringify({
    multilineEnabled: false,
    sortingSelection: { sortBySelectionParam: '3', ascendingSortingOrder: 'false' },
    fieldData: { fields: { KEYWORD: cfg.keyword || '' }, valid: true },
    filterSelectionParam: { searchFilterSelections: [{ id: 'LOCATION', selectedValues: locationId ? [locationId] : [] }] },
    advancedSearchFiltersSelectionParam: { searchFilterSelections: [] },
    pageNo,
  });
}

/** "Nov 5, 2026" → epoch ms (UTC midnight); anything else → undefined. @param {unknown} v */
export function toEpochMs(v) {
  if (typeof v !== 'string') return undefined;
  const m = v.trim().match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})$/);
  if (!m) return undefined;
  const mon = MONTHS[m[1].toLowerCase()];
  if (mon === undefined) return undefined;
  const ms = Date.UTC(Number(m[3]), mon, Number(m[2]));
  return Number.isNaN(ms) ? undefined : ms;
}

/** @param {unknown} s */
function clean(s) {
  return typeof s === 'string' ? decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
}

/** Location column: a JSON-encoded string array, or a plain string. @param {unknown} s */
function parseLocation(s) {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  if (t.startsWith('[')) {
    try {
      const arr = JSON.parse(t);
      if (Array.isArray(arr)) return arr.map(clean).filter(Boolean).join('; ');
    } catch {
      /* fall through to the raw text */
    }
  }
  return clean(t);
}

/** @param {any} cfg @param {any} req */
function postingUrl(cfg, req) {
  const id = [req?.contestNo, req?.jobId].find((x) => typeof x === 'string' && JOB_ID_RE.test(x));
  if (!id) return null;
  const q = new URLSearchParams({ job: id, lang: 'en' });
  return `${cfg.origin}/careersection/${encodeURIComponent(cfg.section)}/jobdetail.ftl?${q.toString()}`;
}

/**
 * Pick the "United States" LOCATION facet value (lowest level wins), and
 * whether filtering would drop anything (i.e. any other location exists).
 * @param {any} json
 */
export function findUsLocation(json) {
  const facets = Array.isArray(json?.facetResults) ? json.facetResults : [];
  const loc = facets.find((f) => f && f.id === 'LOCATION');
  const values = Array.isArray(loc?.facetValueResults) ? loc.facetValueResults : [];
  let best = null;
  for (const v of values) {
    if (!v || typeof v.text !== 'string' || typeof v.id !== 'string' || !/^\d{1,20}$/.test(v.id)) continue;
    if (!US_RE.test(v.text.trim())) continue;
    // quantity is a digit string live ("1341"); accept that or a non-negative
    // integer, and ignore a facet whose quantity is anything else (an object
    // here once threw on Number() and lost the whole batch).
    let quantity;
    if (typeof v.quantity === 'string' && /^\d{1,9}$/.test(v.quantity.trim())) quantity = Number(v.quantity.trim());
    else if (Number.isInteger(v.quantity) && v.quantity >= 0) quantity = v.quantity;
    else continue;
    if (v.level !== undefined && v.level !== null && !Number.isInteger(v.level)) continue;
    const level = Number.isInteger(v.level) ? v.level : 99;
    if (!best || level < best.level) best = { id: v.id, level, quantity };
  }
  return best;
}

/**
 * Parse one searchjobs response.
 * - a genuine zero-result answer ({requisitionList: [], pagingData…}) → empty page
 * - null / array / non-object / {} → throw (never a silent empty board)
 * - careerSectionUnAvailable:true → throw (wrong section code / closed board)
 * - requisitionList present but not an array, or neither requisitionList
 *   nor pagingData present → throw (API changed)
 * @param {any} json
 * @param {any} cfg
 */
export function parseSearchResponse(json, cfg) {
  if (json == null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(`taleo: unexpected search response (${Array.isArray(json) ? 'array' : typeof json})`);
  }
  const keys = Object.keys(json);
  if (json.careerSectionUnAvailable === true) {
    throw new Error(`taleo: career section "${cfg.section}" is unavailable on ${cfg.origin} (wrong code or closed board)`);
  }
  if (!('requisitionList' in json) && !('pagingData' in json)) {
    throw new Error(`taleo: unexpected search response shape (keys: ${keys.slice(0, 8).join(', ') || 'none'})`);
  }
  if (!Array.isArray(json.requisitionList)) {
    throw new Error(`taleo: unexpected search response (requisitionList is ${json.requisitionList === null ? 'null' : typeof json.requisitionList})`);
  }
  const list = json.requisitionList;
  const tc = json.pagingData?.totalCount;
  const total = Number.isInteger(tc) && tc >= 0 ? tc : null;
  const rows = [];
  for (const req of list) {
    if (!req || typeof req !== 'object' || !Array.isArray(req.column)) continue;
    const cols = req.column;
    const ti = Number.isInteger(req.linkedColumn) && req.linkedColumn >= 0 && req.linkedColumn < cols.length ? req.linkedColumn : 0;
    const title = clean(cols[ti]);
    const url = postingUrl(cfg, req);
    if (!title || !url) continue;
    const locIdx = Array.isArray(req.locationsColumns) ? req.locationsColumns.filter((i) => Number.isInteger(i) && i >= 0 && i < cols.length && i !== ti) : [];
    const location = locIdx.map((i) => parseLocation(cols[i])).filter(Boolean).join('; ');
    let postedAt;
    for (let i = 0; i < cols.length && postedAt === undefined; i++) {
      if (i === ti || locIdx.includes(i)) continue;
      postedAt = toEpochMs(cols[i]);
    }
    rows.push({ id: url, title, url, location, postedAt });
  }
  return { rows, rawCount: list.length, total };
}

// ── Detail enrichment (upstream 1.40) ───────────────────────────────────
function detailLimit(entry) {
  const value = Number(entry.detailLimit);
  return Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_DETAIL_LIMIT)
    : DEFAULT_DETAIL_LIMIT;
}

function decodeDetail(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  let decoded = value;
  if (/%[0-9a-f]{2}/i.test(decoded)) {
    try { decoded = decodeURIComponent(decoded); } catch { /* keep the original text */ }
  }
  return htmlToText(decoded);
}

function findJobPosting(node) {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  const type = node['@type'];
  if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) return node;
  if (node['@graph']) return findJobPosting(node['@graph']);
  return null;
}

/** Extract the public JobPosting description embedded in Taleo detail HTML. */
export function parseTaleoDetail(html) {
  if (typeof html !== 'string') return '';
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const posting = findJobPosting(JSON.parse(match[1]));
      const description = decodeDetail(posting?.description);
      if (description) return description;
    } catch { /* another JSON-LD block may still be usable */ }
  }
  return '';
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

/** @type {Provider} */
export default {
  id: 'taleo',

  detect(entry) {
    try {
      const raw = entry?.careers_url || entry?.api;
      if (typeof raw !== 'string') return null;
      const u = new URL(raw);
      if (u.protocol !== 'https:' || !HOST_RE.test(u.hostname.toLowerCase()) || u.hostname.toLowerCase() === TALEO_BUSINESS_EDITION_HOST) return null;
      if (!/^\/careersection\/[^/]+\//.test(u.pathname)) return null;
      return { url: u.href };
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry); // throws before any request on a bad host / section
    const url = buildSearchUrl(cfg);
    const reqOpts = (pageNo, locationId) => ({
      method: 'POST',
      redirect: 'error',
      timeoutMs: TIMEOUT_MS,
      headers: { accept: 'application/json', 'content-type': 'application/json', tz: 'GMT-05:00' },
      body: buildSearchBody(cfg, pageNo, locationId),
    });

    const ctxMaxPages = Number(ctx?.maxPages);
    const probing = ctxMaxPages > 0;
    const pagesToFetch = Math.min(resolveMaxPages(entry), probing ? ctxMaxPages : Infinity);

    // Page 1, unfiltered: also tells us whether a US facet exists.
    const first = await fetchJsonWithRetry(ctx, url, reqOpts(1, null));
    let parsed = parseSearchResponse(first, cfg);
    let locationId = null;
    if (cfg.usOnly && !probing) {
      const us = findUsLocation(first);
      if (us && (parsed.total === null || !(us.quantity >= parsed.total))) {
        locationId = us.id;
        await sleep(INTER_PAGE_DELAY_MS, ctx);
        parsed = parseSearchResponse(await fetchJsonWithRetry(ctx, url, reqOpts(1, locationId)), cfg);
      }
    }

    const jobs = [];
    const seen = new Set();
    let total = parsed.total;
    let stopReason = 'end';
    for (let page = 1; page <= pagesToFetch; page++) {
      if (page > 1) {
        await sleep(INTER_PAGE_DELAY_MS, ctx);
        try {
          parsed = parseSearchResponse(await fetchJsonWithRetry(ctx, url, reqOpts(page, locationId)), cfg);
        } catch (err) {
          if (probing) throw err; // unwrapped: probe budget identity must survive
          console.error(`⚠️  taleo: ${entry.name} page ${page} failed (${err?.message}) — keeping ${jobs.length} postings`);
          stopReason = 'error';
          break;
        }
        if (total === null) total = parsed.total;
      }
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
      if (fresh === 0) break;
      if (total !== null && page * PAGE_SIZE >= total) break;
      if (page === pagesToFetch) stopReason = probing ? 'probe' : 'max_pages';
    }

    if (stopReason === 'max_pages' && total !== null && jobs.length < total) {
      console.error(`⚠️  taleo: ${entry.name} truncated at ${jobs.length} of ${total} postings — raise max_pages on this entry for more`);
      /** @type {any} */ (jobs).truncated = { reason: 'page-cap', fetched: jobs.length, total };
    }

    // Health probes are deliberately list-only. Normal scans enrich a bounded
    // prefix so a very large board cannot trigger an unbounded request fanout.
    if (entry.fetchDetails === true && !probing) {
      const subset = jobs.slice(0, detailLimit(entry));
      for (let i = 0; i < subset.length; i++) {
        if (i > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
        try {
          const detailHtml = await fetchTextWithRetry(ctx, subset[i].url, { redirect: 'error' });
          const description = parseTaleoDetail(detailHtml);
          if (description) subset[i].description = description;
        } catch {
          // Detail enrichment is best-effort. Keep the parsed listing row.
        }
      }
    }
    return jobs;
  },
};
