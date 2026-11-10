// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchJsonWithRetry, sleep } from './_http.mjs';
// Titles can arrive HTML-escaped ("Sales &amp; Marketing"); shared decoder (#2487, #2921).
import { decodeEntities } from './_html-entities.mjs';

// Porsche careers provider (→ tracked_companies:).
//
// jobs.porsche.com's search page (index.php?ac=search_result) is a server
// shell; the result list is filled client-side by the milch & zucker "Global
// Job Board" jQuery client. The page names its backend in an inline script —
// `var gjbAddress = "https://porsche-beesite-production-gjb.app.beesite.de/"`
// — and serialises the URL's filters into
// <div id="escapedGjbPrepareSearchCriterion">[{"CriterionName":
// "PositionLocation.Country","CriterionValue":["231"]}]</div>.
// The client then calls (verified live 2026-11-08, no token or cookie needed):
//
//   GET https://porsche-beesite-production-gjb.app.beesite.de/search?data={URL-encoded JSON}
//   data = {"LanguageCode":"EN",
//           "SearchParameters":{"FirstItem":1,"CountItem":100,
//             "Sort":[{"Criterion":"PublicationStartDate","Direction":"DESC"}],
//             "MatchedObjectDescriptor":[…field list…]},
//           "SearchCriteria":[
//             {"CriterionName":"PublicationChannel.Code","CriterionValue":["12"]},
//             {"CriterionName":"PositionLocation.Country","CriterionValue":["231"]}]}
//   → {"SearchResult":{"SearchResultCountAll":46,"SearchResultItems":[
//        {"MatchedObjectId":"22090","MatchedObjectDescriptor":{"ID":"22090",
//          "PositionTitle":"Port Quality Technical Specialist - Davisville",
//          "PositionURI":"https://jobs.porsche.com/index.php?ac=jobad&id=22090",
//          "PositionLocation":[{"CountryName":"United States of America","CityName":"Davisville"}],
//          "PublicationStartDate":"2026-11-06"}}]}}
//
// So no HTML parsing is needed. PublicationChannel 12 is the public internet
// channel (a hidden, pre-selected filter on the page). FirstItem is 1-based.
//
// The careers_url's `search_criterion_*[]` params are translated to the same
// criteria the page builds (URL_PARAM_CRITERIA below), so a URL copied from a
// filtered search on jobs.porsche.com scans exactly that search. Country codes
// are Porsche-internal (231 = United States, 46 = Germany).
//
// portals.yml:
//   - name: "Porsche"
//     provider: "porsche"
//     careers_url: "https://jobs.porsche.com/index.php?ac=search_result&search_criterion_country[]=231"
//     max_pages: 20     # optional (100 postings/page)
//     max_jobs: 2000    # optional
//
// Job URL: https://jobs.porsche.com/index.php?ac=jobad&id={ID}.

const API_ORIGIN = 'https://porsche-beesite-production-gjb.app.beesite.de';
const SITE_ORIGIN = 'https://jobs.porsche.com';
const ALLOWED_HOSTS = new Set(['jobs.porsche.com']);

const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 20; // 2,000 postings; the whole public board was 757 on 2026-11-08
const MAX_PAGES_CAP = 200;
const DEFAULT_MAX_JOBS = 2000;
const MAX_JOBS_CAP = 20000;
const PAGE_DELAY_MS = 150;
const DEFAULT_CHANNEL = '12';

// jobs.porsche.com search form field → GJB criterion (from the form's
// data-criterion attributes).
const URL_PARAM_CRITERIA = {
  search_criterion_channel: 'PublicationChannel.Code',
  search_criterion_activity_level: 'JobCategory.Code',
  search_criterion_entry_level: 'CareerLevel.Code',
  search_criterion_working_hour: 'PositionSchedule.Code',
  search_criterion_limitation: 'PositionOfferingType.Code',
  search_criterion_country: 'PositionLocation.Country',
  search_criterion_physical_location: 'PositionLocation.City',
  search_criterion_division: 'ParentOrganization',
};

// ISO-2 → Porsche country term, for an optional `country:` on the entry.
export const COUNTRY_CODES = Object.freeze({ US: '231', DE: '46' });

const DESCRIPTOR = [
  'ID',
  'PositionID',
  'PositionTitle',
  'PositionURI',
  'PositionLocation.CityName',
  'PositionLocation.CountryName',
  'PublicationStartDate',
];

/** @param {unknown} raw */
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

/** @param {unknown} v @returns {string|null} */
function toCode(v) {
  const s = String(v ?? '').trim();
  return /^\d{1,7}$/.test(s) ? s : null;
}

/**
 * Resolve the entry into request config. Throws (before any network call) on a
 * host outside the pin or an unknown `country:`.
 * @param {any} entry
 */
export function resolveConfig(entry) {
  const raw = entry?.careers_url || entry?.api || '';
  const u = parsePinnedUrl(raw);
  if (!u) {
    throw new Error(`porsche: careers_url must be https://jobs.porsche.com/… (got ${JSON.stringify(raw)})`);
  }
  /** @type {Map<string, string[]>} */
  const crit = new Map();
  for (const [key, value] of u.searchParams) {
    const field = key.replace(/\[\]$/, '');
    const name = URL_PARAM_CRITERIA[/** @type {keyof typeof URL_PARAM_CRITERIA} */ (field)];
    if (!name) continue;
    const code = toCode(value);
    if (code === null) continue;
    const list = crit.get(name) || [];
    if (!list.includes(code)) list.push(code);
    crit.set(name, list);
  }
  if (entry?.country != null && entry.country !== '') {
    const list = Array.isArray(entry.country) ? entry.country : [entry.country];
    const codes = [];
    for (const c of list) {
      const code = toCode(c) ?? COUNTRY_CODES[/** @type {keyof typeof COUNTRY_CODES} */ (String(c).trim().toUpperCase())];
      if (code == null) throw new Error(`porsche: unknown country ${JSON.stringify(c)} for ${entry.name} — use US/DE or the numeric Porsche country code`);
      codes.push(code);
    }
    crit.set('PositionLocation.Country', codes);
  }
  if (!crit.has('PublicationChannel.Code')) crit.set('PublicationChannel.Code', [DEFAULT_CHANNEL]);
  const searchCriteria = [];
  for (const [name, vals] of crit) searchCriteria.push({ CriterionName: name, CriterionValue: vals });
  return { language: 'EN', searchCriteria };
}

/** @param {{language:string, searchCriteria:any[]}} cfg @param {number} firstItem 1-based */
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

/** "City, Country" per location, distinct, joined with " / ". @param {any} d */
export function formatLocation(d) {
  const locs = Array.isArray(d?.PositionLocation) ? d.PositionLocation : [];
  const out = [];
  for (const l of locs) {
    const s = [clean(l?.CityName), clean(l?.CountryName)].filter(Boolean).join(', ');
    if (s && !out.includes(s)) out.push(s);
  }
  return out.join(' / ');
}

/**
 * Posting id → public URL. The id is host-controlled; only a plain numeric id
 * is accepted (that is what the site uses), so nothing needs encoding and a
 * malformed id drops just that posting.
 * @param {any} item @param {any} d
 */
export function jobUrl(item, d) {
  const id = String(d?.ID ?? item?.MatchedObjectId ?? '').trim();
  if (!/^\d{1,12}$/.test(id)) return null;
  return `${SITE_ORIGIN}/index.php?ac=jobad&id=${id}`;
}

/**
 * Map one search response to {total, rows, itemCount}. Empty/contentless body
 * → no rows; an envelope that is not the documented shape → descriptive throw.
 * @param {any} json
 */
export function parseSearchResult(json) {
  if (json == null || (typeof json === 'object' && Object.keys(json).length === 0)) {
    return { total: 0, rows: [], itemCount: 0 };
  }
  const sr = json?.SearchResult;
  if (!sr || typeof sr !== 'object') {
    const keys = json && typeof json === 'object' ? Object.keys(json).join(', ') : typeof json;
    throw new Error(`porsche: unexpected search response (no SearchResult; got ${keys})`);
  }
  if (sr.UserArea && sr.UserArea.ExecutionError) {
    throw new Error(`porsche: search API reported ExecutionError=${sr.UserArea.ExecutionError}`);
  }
  if (sr.SearchResultItems != null && !Array.isArray(sr.SearchResultItems)) {
    throw new Error('porsche: unexpected search response (SearchResultItems is not an array)');
  }
  const total = typeof sr.SearchResultCountAll === 'number' ? sr.SearchResultCountAll : null;
  const items = Array.isArray(sr.SearchResultItems) ? sr.SearchResultItems : [];
  const rows = [];
  for (const item of items) {
    const d = item?.MatchedObjectDescriptor;
    if (!d || typeof d !== 'object') continue;
    const title = clean(d.PositionTitle);
    if (!title) continue;
    const url = jobUrl(item, d);
    if (!url) continue;
    rows.push({ key: url, title, url, location: formatLocation(d), postedAt: toEpochMs(d.PublicationStartDate) });
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
  id: 'porsche',

  // Exact host pin: jobs.porsche.com only.
  detect(entry) {
    const u = parsePinnedUrl(entry?.careers_url || entry?.api);
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
        if (page === 0 || ctx?.maxPages) throw err;
        console.error(`⚠️  porsche: ${entry.name} stopped at page ${page + 1} (${jobs.length}${total != null ? ` of ${total}` : ''} jobs kept): ${err.message}`);
        stopReason = 'fetch-error';
        break;
      }
      const res = parseSearchResult(json);
      if (total === null) total = res.total;
      for (const row of res.rows) {
        if (seen.has(row.key)) continue;
        seen.add(row.key);
        const job = { title: row.title, url: row.url, company: entry.name, location: row.location };
        if (typeof row.postedAt === 'number') job.postedAt = row.postedAt;
        jobs.push(job);
      }
      if (jobs.length >= maxJobs) {
        if ((total ?? 0) > maxJobs || res.itemCount === PAGE_SIZE) stopReason = 'max_jobs';
        break;
      }
      if (res.itemCount < PAGE_SIZE) break;
      if (total !== null && (page + 1) * PAGE_SIZE >= total) break;
    }
    if (stopReason === 'complete' && page === maxPages) stopReason = 'cap';

    if (stopReason === 'cap' || stopReason === 'max_jobs') {
      const returned = Math.min(jobs.length, maxJobs);
      console.error(`⚠️  porsche: ${entry.name} truncated at ${returned}${total != null ? ` of ${total}` : ''} postings — raise max_pages/max_jobs on this entry for more`);
    }
    return jobs.slice(0, maxJobs);
  },
};
