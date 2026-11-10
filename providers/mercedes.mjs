// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchJsonWithRetry, sleep } from './_http.mjs';
// Titles arrive HTML-escaped on some postings; an undecoded "R&amp;D" would fail
// a user's title_filter positive "r&d". Shared decoder (#2487, #2921).
import { decodeEntities } from './_html-entities.mjs';

// Mercedes-Benz Group careers provider (→ tracked_companies:).
//
// jobs.mercedes-benz.com is a Nuxt SPA over the milch & zucker "Global Job
// Board" (GJB / beesite) backend. Its runtime config names the backend as
// `gjbAddress: "https://jobs.api.mercedes-benz.com"`, and the search store
// calls (verified live 2026-11-08 by reading the site bundle and replaying it):
//
//   GET https://jobs.api.mercedes-benz.com/search?data={URL-encoded JSON}
//   data = {"LanguageCode":"EN",
//           "SearchParameters":{"FirstItem":1,"CountItem":100,
//             "Sort":[{"Criterion":"PublicationStartDate","Direction":"DESC"}],
//             "MatchedObjectDescriptor":[…field list…]},
//           "SearchCriteria":[
//             {"CriterionName":"PublicationLanguage.Code","CriterionValue":["EN"]},
//             {"CriterionName":"PositionLocation.Country","CriterionValue":[475]}]}
//   → {"SearchResult":{"SearchResultCount":n,"SearchResultCountAll":TOTAL,
//        "SearchResultItems":[{"MatchedObjectId":"244919",
//          "MatchedObjectDescriptor":{"PositionID":"mer0004a3t",
//            "PositionTitle":…,
//            "PositionURI":"https://jobs.mercedes-benz.com/applied-ai-ml-solutions-engineer-244919-MER0004A3T",
//            "PositionLocation":[{"CountryName":"United States","CityName":"Atlanta, GA"}],
//            "PublicationStartDate":"2026-11-06"}}]}}
//
// - FirstItem is 1-based; past the end → empty item list. 100/page is served.
// - PublicationLanguage.Code: the site always sends the UI locale (EN/DE/HU).
//   Without it every posting comes back once per published language (US: 240
//   items for 81 PositionIDs); with EN it is 81 — the count the site shows.
//   We also dedup by PositionID as a second line of defence.
// - Facet values are tenant-internal numeric codes. Country codes (from the
//   live facet + /lookup/country): 475 = United States, 329 = Germany, …
//   (COUNTRY_CODES below). The site's own URL carries the same names as query
//   params (`/en?PositionLocation.Country=475`), so a careers_url copied from a
//   filtered search keeps its filters.
//
// portals.yml:
//   - name: "Mercedes-Benz"
//     provider: "mercedes"
//     careers_url: "https://jobs.mercedes-benz.com/en"   # /en, /de, /hu → language + link prefix
//     country: "US"     # optional; ISO-2 from COUNTRY_CODES or a numeric GJB code. Default: all
//     max_pages: 20     # optional (100 postings/page)
//     max_jobs: 2000    # optional
//
// Job URL: https://jobs.mercedes-benz.com/{lang}/{slug}, where {slug} is the
// path of PositionURI ("{title}-{MatchedObjectId}-{PositionID}"), matching the
// site route `/:lang/:title-:id-:customerKey`.

const API_ORIGIN = 'https://jobs.api.mercedes-benz.com';
const SITE_ORIGIN = 'https://jobs.mercedes-benz.com';
// careers_url / api may point at the branded front or the API host; nothing else.
const ALLOWED_HOSTS = new Set(['jobs.mercedes-benz.com', 'jobs.api.mercedes-benz.com']);

const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 20; // 2,000 postings; the whole board (all countries, EN) was 860 on 2026-11-08
const MAX_PAGES_CAP = 200; // hard ceiling even for a user override
const DEFAULT_MAX_JOBS = 2000;
const MAX_JOBS_CAP = 20000;
const PAGE_DELAY_MS = 150;

// Locale path segment → PublicationLanguage / LanguageCode. The site's default
// locale (no prefix) is German. enUS shares the EN publications.
const LOCALES = { en: 'EN', de: 'DE', hu: 'HU', enus: 'EN' };

// ISO-3166 alpha-2 → GJB country term. Only countries that carried postings in
// the live facet on 2026-11-08; any other country can be given as its numeric code.
export const COUNTRY_CODES = Object.freeze({
  US: 475, DE: 329, CN: 446, IN: 390, HU: 352, PL: 325, MY: 427, VN: 342, KR: 374,
  CA: 369, GB: 410, UK: 410, TH: 451, AT: 320, SG: 404, JP: 443, EG: 350, TW: 516,
  RO: 267, ZA: 501,
});

// Query params of the site URL that map 1:1 onto GJB criteria.
const URL_CRITERIA = [
  'PositionLocation.Country',
  'CareerLevel.Code',
  'JobCategory.Code',
  'PositionSchedule.Code',
  'TargetGroup.Code',
  'ParentOrganization',
];

const DESCRIPTOR = [
  'PositionID',
  'PositionTitle',
  'PositionURI',
  'PositionLocation.CityName',
  'PositionLocation.CountryName',
  'PublicationStartDate',
];

/**
 * Parse + pin a config URL. Returns the URL object or null (never throws).
 * @param {unknown} raw
 */
function parsePinnedUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) return null;
  return u;
}

/** @param {unknown} v @returns {number|null} */
function toCode(v) {
  const s = String(v ?? '').trim();
  return /^\d{1,6}$/.test(s) ? Number(s) : null;
}

/**
 * Resolve the entry into request config. Throws a descriptive error for a
 * config that would otherwise silently scan the wrong thing (bad host, unknown
 * country) — that is a portals.yml mistake, not an empty board.
 * @param {any} entry
 */
export function resolveConfig(entry) {
  const raw = entry?.careers_url || entry?.api || '';
  const u = parsePinnedUrl(raw);
  if (!u) {
    throw new Error(`mercedes: careers_url must be https://jobs.mercedes-benz.com/… (got ${JSON.stringify(raw)})`);
  }
  const seg = (u.hostname === 'jobs.mercedes-benz.com' ? u.pathname.split('/')[1] || '' : 'en').toLowerCase();
  const language = LOCALES[seg] || 'DE';
  // Link prefix mirrors the locale the user pointed at ("" for the German root).
  const linkPrefix = LOCALES[seg] ? `/${seg === 'enus' ? 'enUS' : seg}` : '';

  /** @type {Map<string, number[]>} */
  const crit = new Map();
  for (const name of URL_CRITERIA) {
    const vals = u.searchParams.getAll(name).flatMap((v) => v.split(',')).map(toCode).filter((n) => n !== null);
    if (vals.length) crit.set(name, /** @type {number[]} */ (vals));
  }
  if (entry?.country != null && entry.country !== '') {
    const list = Array.isArray(entry.country) ? entry.country : [entry.country];
    const codes = [];
    for (const c of list) {
      const numeric = toCode(c);
      const iso = String(c).trim().toUpperCase();
      const code = numeric ?? COUNTRY_CODES[/** @type {keyof typeof COUNTRY_CODES} */ (iso)];
      if (code == null) throw new Error(`mercedes: unknown country ${JSON.stringify(c)} for ${entry.name} — use an ISO code from COUNTRY_CODES or the numeric GJB code`);
      codes.push(code);
    }
    crit.set('PositionLocation.Country', codes);
  }

  const searchCriteria = [{ CriterionName: 'PublicationLanguage.Code', CriterionValue: [language] }];
  for (const [name, vals] of crit) searchCriteria.push({ CriterionName: name, CriterionValue: vals });
  return { language, linkPrefix, searchCriteria };
}

/**
 * @param {{language:string, searchCriteria:any[]}} cfg
 * @param {number} firstItem 1-based
 */
export function buildSearchUrl(cfg, firstItem) {
  const data = {
    LanguageCode: cfg.language,
    SearchParameters: {
      FirstItem: firstItem,
      CountItem: PAGE_SIZE,
      Sort: [{ Criterion: 'PublicationStartDate', Direction: 'DESC' }],
      MatchedObjectDescriptor: DESCRIPTOR,
    },
    SearchCriteria: cfg.searchCriteria,
  };
  return `${API_ORIGIN}/search?data=${encodeURIComponent(JSON.stringify(data))}`;
}

/** "2026-11-06" → epoch ms (UTC), NaN-safe. @param {unknown} raw */
export function toEpochMs(raw) {
  const m = typeof raw === 'string' ? raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})/) : null;
  if (!m) return undefined;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(ms) ? undefined : ms;
}

/** @param {unknown} s */
function clean(s) {
  if (s != null && typeof s === 'object') return '';
  return decodeEntities(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** "City, Country" for each location, distinct, joined with " / ". @param {any} d */
export function formatLocation(d) {
  const locs = Array.isArray(d?.PositionLocation) ? d.PositionLocation : [];
  const out = [];
  for (const l of locs) {
    const parts = [clean(l?.CityName), clean(l?.CountryName)].filter(Boolean);
    const s = parts.join(', ');
    if (s && !out.includes(s)) out.push(s);
  }
  return out.join(' / ');
}

// Slug segment from a host-controlled value: only URL-safe characters (plus
// already-percent-encoded octets), so no re-encoding and no URIError on a lone
// surrogate. A slug may start with "-" — titles that open with CJK characters
// slugify to "-project-system-engineer-245162-MER00049OD" (seen live).
const SLUG_RE = /^(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+$/;

/**
 * Public job URL for one posting, or null to drop it.
 * @param {any} item @param {any} d @param {string} linkPrefix
 */
export function jobUrl(item, d, linkPrefix) {
  const rawUri = String(d?.PositionURI || '');
  // A lone surrogate would be silently turned into U+FFFD by new URL(); drop
  // the posting instead of emitting a degraded URL (dedup key).
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(rawUri)) return null; // Node 18 has no isWellFormed()
  let slug = '';
  try {
    const u = new URL(rawUri);
    if (u.protocol === 'https:' && u.hostname === 'jobs.mercedes-benz.com') {
      // Strip any locale prefix the URI may already carry.
      slug = u.pathname.replace(/^\/(?:en|de|hu|enUS)(?=\/)/i, '').replace(/^\/+|\/+$/g, '');
    }
  } catch {
    // fall through to the constructed slug
  }
  if (!slug) {
    const id = String(item?.MatchedObjectId ?? '');
    const key = String(d?.PositionID ?? '').toUpperCase();
    const titleSlug = String(d?.PositionTitle ?? '').toLowerCase().normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (titleSlug && /^\d+$/.test(id) && /^[A-Z0-9]+$/.test(key)) slug = `${titleSlug}-${id}-${key}`;
  }
  if (!slug || !SLUG_RE.test(slug)) return null;
  return `${SITE_ORIGIN}${linkPrefix}/${slug}`;
}

/**
 * Map one search response to {total, rows}. Throws on an envelope that is not
 * the documented shape; returns empty rows on an empty/contentless body.
 * @param {any} json @param {{linkPrefix:string}} cfg
 */
export function parseSearchResult(json, cfg) {
  if (json == null || (typeof json === 'object' && !Array.isArray(json) && Object.keys(json).length === 0)) {
    return { total: 0, rows: [] };
  }
  if (Array.isArray(json) && json.length === 0) return { total: 0, rows: [] };
  const sr = json?.SearchResult;
  if (!sr || typeof sr !== 'object') {
    const keys = json && typeof json === 'object' ? Object.keys(json).join(', ') : typeof json;
    throw new Error(`mercedes: unexpected search response (no SearchResult; got ${keys})`);
  }
  if (sr.UserArea && sr.UserArea.ExecutionError) {
    throw new Error(`mercedes: search API reported ExecutionError=${sr.UserArea.ExecutionError}`);
  }
  if (sr.SearchResultItems != null && !Array.isArray(sr.SearchResultItems)) {
    throw new Error('mercedes: unexpected search response (SearchResultItems is not an array)');
  }
  const total = typeof sr.SearchResultCountAll === 'number' ? sr.SearchResultCountAll : null;
  const items = Array.isArray(sr.SearchResultItems) ? sr.SearchResultItems : [];
  const rows = [];
  for (const item of items) {
    const d = item?.MatchedObjectDescriptor;
    if (!d || typeof d !== 'object') continue;
    const title = clean(d.PositionTitle);
    if (!title) continue;
    const url = jobUrl(item, d, cfg.linkPrefix);
    if (!url) continue;
    const key = String(d.PositionID || item.MatchedObjectId || url).toLowerCase();
    rows.push({ key, title, url, location: formatLocation(d), postedAt: toEpochMs(d.PublicationStartDate) });
  }
  return { total, rows, itemCount: items.length };
}

/** @param {any} entry */
export function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

/** @param {any} entry */
export function resolveMaxJobs(entry) {
  const v = entry?.max_jobs;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_JOBS_CAP);
  return DEFAULT_MAX_JOBS;
}

/** @type {Provider} */
export default {
  id: 'mercedes',

  // Exact host pin: only the Mercedes-Benz careers front / API host.
  detect(entry) {
    const raw = entry?.careers_url || entry?.api;
    const u = parsePinnedUrl(raw);
    return u ? { url: u.href } : null;
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry); // throws before any network call on a bad host
    const maxPages = resolveMaxPages(entry);
    const maxJobs = resolveMaxJobs(entry);
    const ctxCap = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity;
    const pagesToFetch = Math.min(maxPages, ctxCap);

    const jobs = [];
    const seen = new Set();
    let total = null;
    let stopReason = 'complete';
    let page = 0;
    for (; page < pagesToFetch; page++) {
      if (page > 0) await sleep(PAGE_DELAY_MS, ctx);
      let json;
      try {
        json = await fetchJsonWithRetry(ctx, buildSearchUrl(cfg, page * PAGE_SIZE + 1), {
          redirect: 'error',
          headers: { accept: 'application/json' },
        });
      } catch (err) {
        // First page or a health probe: propagate unwrapped (a dead board must
        // not read as empty; ProbePageBudgetReached identity must survive).
        if (page === 0 || ctx?.maxPages) throw err;
        console.error(`⚠️  mercedes: ${entry.name} stopped at page ${page + 1} (${jobs.length}${total != null ? ` of ${total}` : ''} jobs kept): ${err.message}`);
        stopReason = 'fetch-error';
        break;
      }
      const res = parseSearchResult(json, cfg);
      if (total === null) total = res.total;
      for (const row of res.rows) {
        if (seen.has(row.key)) continue;
        seen.add(row.key);
        const job = { title: row.title, url: row.url, company: entry.name, location: row.location };
        if (typeof row.postedAt === 'number') job.postedAt = row.postedAt;
        jobs.push(job);
      }
      if (jobs.length >= maxJobs) {
        if ((total ?? 0) > maxJobs || (res.itemCount ?? 0) === PAGE_SIZE) stopReason = 'max_jobs';
        break;
      }
      if ((res.itemCount ?? 0) < PAGE_SIZE) break; // last page
      if (total !== null && (page + 1) * PAGE_SIZE >= total) break;
    }
    if (stopReason === 'complete' && page === maxPages && maxPages <= pagesToFetch) stopReason = 'cap';

    if (stopReason === 'cap' || stopReason === 'max_jobs') {
      const returned = Math.min(jobs.length, maxJobs);
      console.error(`⚠️  mercedes: ${entry.name} truncated at ${returned}${total != null ? ` of ${total}` : ''} postings — raise max_pages/max_jobs on this entry for more`);
    }
    return jobs.slice(0, maxJobs);
  },
};
