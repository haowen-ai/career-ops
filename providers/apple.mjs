// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { BROWSER_LIKE_USER_AGENT, fetchTextWithRetry } from './_http.mjs';

// Apple Jobs provider (→ tracked_companies:). jobs.apple.com is Apple's own
// career site (no third-party ATS). Its search page is server-rendered by a
// React Router app that embeds the full result page as hydration data:
//
//   GET https://jobs.apple.com/<locale>/search?location=united-states-USA[&team=…][&search=…]&page=<N>
//
//   window.__staticRouterHydrationData = JSON.parse("<JSON string literal>");
//     → { loaderData: { search: { searchResults: [ … ], totalRecords, page, … } } }
//
// Per result (verified live 2026-11-08): id ("200687778-0836" or
// "PIPE-114438158"), positionId, type ("REQ" | "PIPE"), postingTitle,
// transformedPostingTitle (URL slug), locations[].name, postDateInGMT (ISO),
// team.teamCode. The public posting page — the same href the search page
// renders — is
//   https://jobs.apple.com/<locale>/details/<id>/<slug>?team=<teamCode>
// where <id> is `id` with a leading "PIPE-" removed (pipeline roles carry
// ids like "PIPE-114438158"; others "200683980-0836", whatever `type` says).
// One requisition open in several cities is one row per city (different id
// suffix, different page), so rows are kept as-is and deduped by id.
//
// Page size is fixed by the server (20). 4,604 US rows on 11/08 → 231 pages of
// ~330 KB; pages are paced and the loop is bounded by max_pages.
//
// careers_url carries the filters; only ALLOWED_PARAMS are forwarded (`page`
// is owned by the provider). Host and path shape are pinned before any
// request; redirects are refused.
//
// Failure policy: missing/unparsable hydration data, or a `search` loader
// without a searchResults array and numeric totalRecords → throw. A malformed
// row is skipped and counted; a page whose rows all fail throws. Paging uses
// the raw row count; a short page before totalRecords does not end the loop,
// and a final shortfall is reported as truncated on stderr.

const HOST = 'jobs.apple.com';
const PATH_RE = /^\/([a-z]{2}-[a-z]{2})\/search\/?$/;
const ALLOWED_PARAMS = new Set(['location', 'team', 'search', 'sort', 'key', 'product', 'homeOffice']);
const PAGE_SIZE = 20;
const DEFAULT_MAX_PAGES = 300;
const MAX_PAGES_CAP = 1000;
const INTER_PAGE_DELAY_MS = 300;
const RETRY_POLICY = { retries: 3, baseDelayMs: 1000, maxDelayMs: 10_000 };
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,60}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,200}$/;
const TEAM_RE = /^[A-Z0-9]{2,20}$/;

/**
 * Validate careers_url and derive {locale, params}. Throws before any request.
 * @param {any} entry
 * @returns {{locale: string, params: Array<[string,string]>}}
 */
export function resolveConfig(entry) {
  const raw = entry?.careers_url || entry?.api;
  if (typeof raw !== 'string' || !raw) throw new Error('apple: careers_url is required');
  const u = new URL(raw); // throws on malformed input
  if (u.protocol !== 'https:') throw new Error(`apple: refusing non-https URL ${u.protocol}`);
  if (u.hostname.toLowerCase() !== HOST) throw new Error(`apple: host not allowed: ${u.hostname}`);
  if (u.username || u.password || u.port) throw new Error('apple: credentials/port not allowed in careers_url');
  const m = PATH_RE.exec(u.pathname);
  if (!m) throw new Error(`apple: careers_url must be /<locale>/search, got ${u.pathname}`);
  /** @type {Array<[string,string]>} */
  const params = [];
  for (const [k, v] of u.searchParams) {
    if (k === 'page') continue;
    if (!ALLOWED_PARAMS.has(k)) throw new Error(`apple: unsupported careers_url parameter ${JSON.stringify(k)}`);
    params.push([k, v]);
  }
  return { locale: m[1], params };
}

/** @param {{locale:string, params:Array<[string,string]>}} cfg @param {number} page 1-based */
export function buildPageUrl(cfg, page) {
  const sp = new URLSearchParams();
  for (const [k, v] of cfg.params) sp.append(k, v);
  if (page > 1) sp.set('page', String(page));
  const qs = sp.toString();
  return `https://${HOST}/${cfg.locale}/search${qs ? `?${qs}` : ''}`;
}

/** @param {string} url */
function assertAppleUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== HOST || !PATH_RE.test(u.pathname)) throw new Error(`apple: refusing request to ${url}`);
  return url;
}

/**
 * Extract the `search` loader data from a search page. Throws on anything
 * that is not the documented shape.
 * @param {string} html
 */
export function extractSearchData(html) {
  if (typeof html !== 'string' || !html) throw new Error('apple: empty search page');
  const m = /__staticRouterHydrationData\s*=\s*JSON\.parse\(("(?:[^"\\]|\\.)*")\)/.exec(html);
  if (!m) throw new Error('apple: search page has no hydration data (page layout changed or request blocked)');
  let data;
  try {
    data = JSON.parse(JSON.parse(m[1]));
  } catch (err) {
    throw new Error(`apple: hydration data is not valid JSON (${/** @type {Error} */ (err).message})`);
  }
  const search = data?.loaderData?.search;
  if (!search || typeof search !== 'object') {
    throw new Error(`apple: hydration data has no search loader (keys: ${Object.keys(data?.loaderData ?? {}).join(', ') || 'none'})`);
  }
  if (!Array.isArray(search.searchResults)) throw new Error('apple: search.searchResults is not an array');
  if (typeof search.totalRecords !== 'number' || !Number.isFinite(search.totalRecords) || search.totalRecords < 0) {
    throw new Error(`apple: search.totalRecords is not a number (${JSON.stringify(search.totalRecords)})`);
  }
  return search;
}

/**
 * Map one page of results. Skips malformed rows (counted).
 * @param {{searchResults:any[]}} search
 * @param {string} locale
 * @param {string} companyName
 */
export function parseResults(search, locale, companyName) {
  const jobs = [];
  let skipped = 0;
  for (const r of search.searchResults) {
    try {
      if (!r || typeof r !== 'object') { skipped++; continue; }
      const title = typeof r.postingTitle === 'string' ? r.postingTitle.replace(/\s+/g, ' ').trim() : '';
      // The rendered href uses `id`, minus a leading "PIPE-" (pipeline roles).
      const id = typeof r.id === 'string' || typeof r.id === 'number' ? String(r.id).trim().replace(/^PIPE-/, '') : '';
      // Slug: Apple's own when it is plain ASCII; otherwise (accented or odd
      // characters seen live) it is percent-encoded as one path segment, and
      // a missing slug is derived from the title. The id identifies the page.
      const rawSlug = typeof r.transformedPostingTitle === 'string' ? r.transformedPostingTitle.trim() : '';
      const slug = SLUG_RE.test(rawSlug) ? rawSlug
        : rawSlug ? encodeURIComponent(rawSlug)
          : title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (!title || !ID_RE.test(id) || !slug) { skipped++; continue; }
      const team = typeof r.team?.teamCode === 'string' && TEAM_RE.test(r.team.teamCode) ? r.team.teamCode : '';
      const url = `https://${HOST}/${locale}/details/${encodeURIComponent(id)}/${slug}${team ? `?team=${team}` : ''}`;
      const locs = [];
      if (Array.isArray(r.locations)) {
        for (const l of r.locations) {
          const name = typeof l?.name === 'string' ? l.name.trim() : '';
          const country = typeof l?.countryName === 'string' ? l.countryName.trim() : '';
          // level 1 = the country itself ("United States"); city rows get the country appended.
          if (name) locs.push(country && l.level !== 1 && !name.includes(country) ? `${name}, ${country}` : name);
        }
      }
      /** @type {{id:string,title:string,url:string,company:string,location:string,postedAt?:number}} */
      const job = { id: String(r.id ?? id), title, url, company: companyName, location: [...new Set(locs)].join(' · ') };
      const ms = typeof r.postDateInGMT === 'string' ? Date.parse(r.postDateInGMT) : NaN;
      if (Number.isFinite(ms) && ms > 0) job.postedAt = ms;
      jobs.push(job);
    } catch {
      skipped++;
    }
  }
  if (search.searchResults.length > 0 && jobs.length === 0) {
    throw new Error(`apple: ${search.searchResults.length} rows on the page but none parsed (row shape changed?)`);
  }
  return { jobs, rawCount: search.searchResults.length, skipped };
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
  id: 'apple',

  detect(entry) {
    try {
      const raw = entry?.careers_url || entry?.api;
      if (typeof raw !== 'string') return null;
      return { url: buildPageUrl(resolveConfig({ careers_url: raw }), 1) };
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
      const url = assertAppleUrl(buildPageUrl(cfg, page));
      const html = await fetchTextWithRetry(ctx, url, {
        redirect: 'error',
        headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
      }, RETRY_POLICY);
      pagesFetched = page;
      const search = extractSearchData(html);
      if (total === null) total = search.totalRecords;
      const res = parseResults(search, cfg.locale, entry.name);
      raw += res.rawCount;
      skipped += res.skipped;
      for (const j of res.jobs) {
        if (seen.has(j.id)) continue;
        seen.add(j.id);
        all.push(j);
      }
      if (res.rawCount === 0) break;
      if (raw >= total) break;
      if (page * PAGE_SIZE >= total && res.rawCount < PAGE_SIZE) break;
    }

    if (skipped > 0) console.error(`⚠️  apple: ${entry.name} skipped ${skipped} malformed rows`);
    if (total !== null && raw < total) {
      const why = pagesFetched >= maxPages ? `max_pages=${maxPages}` : 'short pages';
      console.error(`⚠️  apple: ${entry.name} truncated (${why}): ${raw} of ${total} rows read — raise max_pages or narrow the careers_url filters`);
    }
    return all;
  },
};
