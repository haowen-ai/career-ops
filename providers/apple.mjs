// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
/** @typedef {import('./_types.js').Job} Job */

import { BROWSER_LIKE_USER_AGENT, fetchTextWithRetry, sleep } from './_http.mjs';
import { coerceId } from './_ids.mjs';
import { createEarlyStop, markCollection } from './_early-stop.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';

// Apple provider — jobs.apple.com is a React Router SSR app with NO usable JSON API.
//
// Why not the API: `POST /api/v1/search` exists (with an X-Apple-CSRF-Token from
// `GET /api/v1/CSRFToken`) but returns `{"res":{"searchResults":[],"totalRecords":0}}`
// for every payload shape, cookies and Referer included. Observing the live page in a
// browser shows the SPA never calls it — the search results are server-rendered and
// embedded in the HTML as a React Router hydration blob:
//
//   window.__staticRouterHydrationData = JSON.parse("{...}");
//     -> loaderData.search.searchResults   (20 jobs/page)
//     -> loaderData.search.totalRecords
//
// So this provider fetches the ordinary search URL over plain HTTP and reads that blob.
// Zero tokens, no browser required.
//
// Two complementary discovery modes, both deduped by URL. Neither has a default:
// a built-in list would be one user's search profile applied to everyone's scan
// (the occ.mjs precedent), so an entry needs at least one non-empty `queries` or
// `teams` value and throws without one. Example portals.yml entry:
//
//   - name: Apple
//     careers_url: https://jobs.apple.com/en-us/search
//     apple:
//       location: united-states-USA            # optional, this is the default
//       queries: ["business operations"]
//       teams: ["business-process-management-OPMFG-BPM"]
//     max_pages: 2
//
//   queries: text search with `sort=relevance`. Apple's text match is loose (it hits
//            job descriptions too, so "business operations" reports 2000+ records), but
//            relevance ranking puts the real title matches on page 1-2 — hence max_pages.
//   teams:   team-slug filter (e.g. business-process-management-OPMFG-BPM). Precise and
//            small. This is how Apple's non-obvious orgs are reachable at all: Apple has
//            no "Corporate Strategy" title — that work lives in Operations under
//            "Business Process Re-Engineering (BPR)".
//
// scan.mjs's title_filter still does the actual role selection; this provider only
// supplies candidates.

const ALLOWED_HOST = 'jobs.apple.com';
const BASE = 'https://jobs.apple.com';
const PAGE_SIZE = 20;

// No UA override. An earlier version sent a Chrome string on the theory that
// Apple 403s a bare UA; measured, it does not — the SSR route returns the same
// 313,692-byte page carrying the same hydration blob to career-ops' own
// User-Agent, to a bare `node`, and to that Chrome string. `_http.mjs` sets the
// shared identifying UA, which is what robots.txt rules and any rate limit
// should be able to name (RFC 9110 §10.1.5, RFC 9309 §2.2.1).

const DEFAULT_LOCATION = 'united-states-USA';
// `max_pages` on the ENTRY (not inside the `apple:` block), with a hard ceiling
// so one portals.yml line cannot turn into an unbounded walk, and a warning when
// the ceiling actually truncated a board — the convention in
// providers/ADDING_A_PROVIDER.md, reference implementation workday.mjs.
const DEFAULT_MAX_PAGES = 2;
const MAX_PAGES_CAP = 50; // 50 pages x 20 rows x (queries + teams) is already generous

// Pages after the first are paced, and every page fetch is retried through the
// shared helper (429/5xx/transport only, backoff + jitter, capped Retry-After).
const INTER_PAGE_DELAY_MS = 200;

/** @param {import('./_types.js').PortalEntry} entry */
function resolveMaxPages(entry) {
  const v = /** @type {any} */ (entry)?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

// Matches the escaped JSON string argument, honouring backslash escapes so an
// embedded \" inside the blob can't terminate the capture early.
const HYDRATION_RE = /window\.__staticRouterHydrationData\s*=\s*JSON\.parse\("((?:\\.|[^"\\])*)"\)/;

/** @param {string} url */
function assertAppleUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`apple: invalid URL: ${url}`); }
  if (parsed.protocol !== 'https:') throw new Error(`apple: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== ALLOWED_HOST) throw new Error(`apple: untrusted hostname "${parsed.hostname}" — must be ${ALLOWED_HOST}`);
  return url;
}

/**
 * Pull loaderData.search out of the SSR hydration blob.
 * @param {string} html
 * @returns {{ searchResults?: unknown, totalRecords?: number } | null}
 */
export function parseHydration(html) {
  const m = HYDRATION_RE.exec(html || '');
  if (!m) return null;
  try {
    // The blob is a JSON string literal inside JSON.parse("..."), so it needs
    // unescaping (pass 1) before it parses as JSON (pass 2).
    const data = JSON.parse(JSON.parse(`"${m[1]}"`));
    return data?.loaderData?.search ?? null;
  } catch {
    return null;
  }
}

/**
 * A city arrives as a bare `Cupertino` with `countryName` beside it, and a
 * location filter that names a country has only this string to match. Level 1
 * entries are the country already, in a shorter spelling: `United States`
 * against `United States of America`.
 *
 * @param {any} l
 */
function placeOf(l) {
  const name = l?.name;
  const country = l?.countryName;
  // Only two strings are joined. Anything else passes through as it did before
  // the join, where name.includes() would throw and fail the whole page.
  if (typeof name !== 'string' || typeof country !== 'string') return name;
  return name && country && l.level !== 1 && !name.includes(country) ? `${name}, ${country}` : name;
}

/** @param {any} r */
function locationOf(r) {
  const names = (Array.isArray(r.locations) ? r.locations : [])
    .map(placeOf)
    .filter(Boolean);
  const uniq = [...new Set(names)];
  if (uniq.length) return uniq.join('; ');
  return r.isMultiLocation ? 'Various Locations within United States' : '';
}

/**
 * Every segment comes from Apple's hydration payload, so every segment is
 * encoded: a raw "/", "?" or "#" in transformedPostingTitle would restructure
 * the URL, and a lone surrogate makes encodeURIComponent throw mid-board
 * (CodeRabbit, #4078). null drops that one posting, never the board.
 *
 * @param {any} r
 * @returns {string|null}
 */
function urlOf(r) {
  const id = safeEncodeURIComponent(r.id);
  const slug = safeEncodeURIComponent(r.transformedPostingTitle || 'role');
  const team = r.team?.teamCode ? safeEncodeURIComponent(r.team.teamCode) : '';
  if (id === null || slug === null || team === null) return null;
  return `${BASE}/en-us/details/${id}/${slug}${team ? `?team=${team}` : ''}`;
}

// Each search row carries a `type`, "REQ" or "PIPE". It is only in the
// hydration data, not in the visible job text, and the posting does not say
// what PIPE means, so the note claims no more than the label. It is a hint on
// the pipeline entry; nothing is filtered on it.
const PIPE_NOTE = 'Apple labels this posting PIPE: it may be a talent pipeline, not a specific opening';

/** @param {any} r @param {string} company @returns {Job|null} */
function toJob(r, company) {
  const url = urlOf(r);
  if (!url) return null;
  const posted = Date.parse(r.postDateInGMT || '');
  const externalId = coerceId(r.id);
  return {
    title: String(r.postingTitle || '').trim(),
    url,
    company,
    location: locationOf(r),
    // Apple's own posting id, the same value the detail URL is built from. It
    // survives a title edit, which the URL does not (#4076's Job.externalId).
    ...(externalId ? { externalId } : {}),
    ...(Number.isNaN(posted) ? {} : { postedAt: posted }),
    ...(r.type === 'PIPE' ? { note: PIPE_NOTE } : {}),
  };
}

/**
 * One search page, empty-vs-broken split per providers/ADDING_A_PROVIDER.md §2:
 * a present-and-empty `searchResults` array is a real "no matches" and yields
 * no jobs; a missing blob, or a `searchResults` that is absent or not an array,
 * is a changed page shape and throws. Read as zero, it would hide a dead
 * provider forever.
 *
 * @param {string} html
 * @param {string} url  the page fetched, named in the error
 * @param {string} company
 * @returns {{ jobs: Job[], rowCount: number, total: number }}
 */
export function parseSearchPage(html, url, company) {
  const search = parseHydration(html);
  if (!search) {
    throw new Error(`apple: no hydration blob in ${url} — Apple's SSR markup changed, or the page was not the search route`);
  }
  const rows = search.searchResults;
  if (!Array.isArray(rows)) {
    throw new Error(`apple: loaderData.search.searchResults in ${url} is ${rows === undefined ? 'missing' : `a ${rows === null ? 'null' : typeof rows}`}, not an array — Apple's search payload changed`);
  }
  /** @type {Job[]} */
  const jobs = [];
  for (const r of rows) {
    if (!r?.postingTitle || !r?.id) continue;
    const job = toJob(r, company);
    if (job) jobs.push(job);
  }
  return { jobs, rowCount: rows.length, total: Number(search.totalRecords) || 0 };
}

/** @param {Record<string, string>} params */
function searchUrl(params) {
  const qs = new URLSearchParams(params).toString();
  return `${BASE}/en-us/search?${qs}`;
}

// ── Whole-board mode (career-journal fork) ─────────────────────────────
const BOARD_HOST = 'jobs.apple.com';
const PATH_RE = /^\/([a-z]{2}-[a-z]{2})\/search\/?$/;
const ALLOWED_PARAMS = new Set(['location', 'team', 'search', 'sort', 'key', 'product', 'homeOffice']);
const BOARD_PAGE_SIZE = 20;
const BOARD_DEFAULT_MAX_PAGES = 300;
const BOARD_MAX_PAGES_CAP = 1000;
const BOARD_INTER_PAGE_DELAY_MS = 300;
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
  if (u.hostname.toLowerCase() !== BOARD_HOST) throw new Error(`apple: host not allowed: ${u.hostname}`);
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
  return `https://${BOARD_HOST}/${cfg.locale}/search${qs ? `?${qs}` : ''}`;
}

/** @param {string} url */
function assertBoardUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== BOARD_HOST || !PATH_RE.test(u.pathname)) throw new Error(`apple: refusing request to ${url}`);
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
      const url = `https://${BOARD_HOST}/${locale}/details/${safeEncodeURIComponent(id)}/${slug}${team ? `?team=${team}` : ''}`;
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
function resolveBoardMaxPages(entry, ctx) {
  const v = entry?.max_pages;
  const fromEntry = Number.isInteger(v) && v > 0 ? Math.min(v, BOARD_MAX_PAGES_CAP) : BOARD_DEFAULT_MAX_PAGES;
  const hint = Number(ctx?.maxPages);
  return Number.isFinite(hint) && hint > 0 ? Math.min(fromEntry, Math.floor(hint)) : fromEntry;
}


// Early stop (career-journal plan 2026-11-14 v5/r2/r3) is allowed on exactly the board whose order was proved live
// (2026-11-15, four full passes): /en-us/search?location=united-states-USA, sorted by postDateInGMT newest first, the
// same field parseResults reports as postedAt. Any other locale, location or parameter reads in full.
const VERIFIED_LOCALE = 'en-us';
const VERIFIED_LOCATION = 'united-states-USA';
const DATE_SORT = 'newest';

/** @param {{locale: string, params: Array<[string,string]>}} cfg */
function earlyStopVerified(cfg) {
  if (cfg.locale !== VERIFIED_LOCALE) return false;
  const locations = cfg.params.filter(([k]) => k === 'location');
  const sorts = cfg.params.filter(([k]) => k === 'sort');
  const others = cfg.params.filter(([k]) => k !== 'location' && k !== 'sort');
  return others.length === 0 && locations.length === 1 && locations[0][1] === VERIFIED_LOCATION
    && (sorts.length === 0 || (sorts.length === 1 && sorts[0][1] === DATE_SORT));
}

/** The row's own id, the identity completeness is counted by (valid and skipped rows alike). @param {any} r */
function rawIdOf(r) {
  const id = r?.id;
  if (typeof id === 'string' && id.trim()) return id.trim();
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return null;
}

// Whole-board mode (career-journal fork): an entry with no apple.queries / apple.teams whose
// careers_url itself carries search filters (e.g. ?location=united-states-USA) reads every row
// of that filtered board, 20 per page, bounded by max_pages (default 300, cap 1000).
//
// With ctx.isKnownListing and ctx.earlyStopBeforeMs, on the verified board only, the pages are requested with
// sort=newest and the walk may stop at a fully known page older than the bound (_early-stop.mjs); a page whose echoed
// sort is not "newest" never counts for the stop. jobs.collection.status is one of:
//   early_stopped;
//   complete     every page with rows reported the first page's totalRecords, the distinct raw ids reached it, and
//                every row had an id;
//   page_failed  an empty page, or a page of ids already read this walk, before that count (a repeated page is not
//                the end of the list);
//   ceiling      max_pages ran out first;
//   unverified   a page reported another total (rows were added or taken down while paging, so offsets shifted and a
//                count cannot prove coverage), or a row had no id; either turns the stop off from that page on.
// A failed page request still throws: the list fails and nothing advances.
/** @param {any} entry @param {any} ctx */
async function fetchBoard(entry, ctx) {
  const cfg = resolveConfig(entry); // throws before any request
  const maxPages = resolveBoardMaxPages(entry, ctx);
  const probing = Number(ctx?.maxPages) > 0;
  const stopper = !probing && earlyStopVerified(cfg) ? createEarlyStop(ctx) : null;
  // Only an early-stopping walk changes the request; every other read is the same request as before.
  const requestCfg = stopper && !cfg.params.some(([k]) => k === 'sort') ? { ...cfg, params: [...cfg.params, ['sort', DATE_SORT]] } : cfg;
  const seen = new Set();
  const rawIds = new Set();
  const all = [];
  let skipped = 0;
  let anonymous = 0;
  /** @type {number|null} */
  let total = null;
  let totalChanged = false;
  let stopOn = Boolean(stopper);
  /** @type {null | 'count' | 'empty' | 'repeated' | 'early'} */
  let end = null;

  for (let page = 1; page <= maxPages; page++) {
    if (page > 1) await sleep(BOARD_INTER_PAGE_DELAY_MS, ctx);
    const url = assertBoardUrl(buildPageUrl(requestCfg, page));
    const html = await fetchTextWithRetry(ctx, url, {
      redirect: 'error',
      headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
    }, RETRY_POLICY);
    const search = extractSearchData(html);
    // The first page's total is the target even when that page is empty (an empty page 1 of a board that reports
    // rows is a failed read, not an empty board). Past the last row Apple serves empty pages with total 0.
    if (total === null) total = search.totalRecords;
    if (search.searchResults.length === 0) { end = 'empty'; break; }
    if (search.totalRecords !== total) totalChanged = true;
    let freshIds = 0;
    for (const r of search.searchResults) {
      const id = rawIdOf(r);
      if (id === null) anonymous++;
      else if (!rawIds.has(id)) { rawIds.add(id); freshIds++; }
    }
    if (page > 1 && freshIds === 0) { end = 'repeated'; break; }
    const res = parseResults(search, cfg.locale, entry.name);
    skipped += res.skipped;
    for (const j of res.jobs) {
      if (seen.has(j.id)) continue;
      seen.add(j.id);
      all.push(j);
    }
    // Off for the rest of the walk: a changed total (offsets shifted), a server that did not sort by date, or a row
    // without an id (it can be neither known nor counted).
    if (totalChanged || anonymous > 0 || search.sort !== DATE_SORT) stopOn = false;
    if (stopOn && stopper?.page(res.jobs)) { end = 'early'; break; }
    // After a total change, read on to the end: the most rows, never a claim of completeness.
    if (!totalChanged && rawIds.size >= total) { end = 'count'; break; }
  }

  /** @type {'complete'|'early_stopped'|'page_failed'|'ceiling'|'unverified'} */
  let status;
  const short = total !== null && rawIds.size < total;
  if (end === 'early') status = 'early_stopped';
  else if (end === null && short) status = 'ceiling';
  else if (totalChanged) status = 'unverified';
  else if (short) status = 'page_failed';
  else if (anonymous > 0) status = 'unverified';
  else status = 'complete';

  if (skipped > 0) console.error(`⚠️  apple: ${entry.name} skipped ${skipped} malformed rows`);
  if (end !== 'early' && short) {
    const capped = end === null;
    console.error(`⚠️  apple: ${entry.name} truncated (${capped ? `max_pages=${maxPages}` : 'short pages'}): ${rawIds.size} of ${total} rows read — raise max_pages or narrow the careers_url filters`);
    /** @type {any} */ (all).truncated = { reason: capped ? 'page-cap' : 'source-reports-more', fetched: all.length, total };
  }
  return markCollection(all, status);
}

/** True when careers_url carries its own search filters (whole-board mode). @param {any} entry */
function hasBoardFilters(entry) {
  try {
    const u = new URL(String(entry?.careers_url || entry?.api || ''));
    return u.hostname === BOARD_HOST && [...u.searchParams.keys()].some((k) => k !== 'page');
  } catch { return false; }
}

/** @type {Provider} */
export default {
  id: 'apple',

  detect(entry) {
    const url = entry.careers_url || '';
    try {
      if (new URL(url).hostname === ALLOWED_HOST) return { url };
    } catch {
      // not a URL — fall through
    }
    return null;
  },

  async fetch(entry, ctx) {
    const cfg = /** @type {any} */ (entry).apple || {};
    const location = cfg.location || DEFAULT_LOCATION;
    const list = (/** @type {unknown} */ v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
    const queries = list(cfg.queries);
    const teams = list(cfg.teams);
    if (!queries.length && !teams.length) {
      if (hasBoardFilters(entry)) return fetchBoard(entry, ctx);
      throw new Error(`apple: entry "${entry.name || 'Apple'}" needs a non-empty apple.queries or apple.teams list `
        + '(e.g. apple: { queries: ["business operations"] }) — there is no default search');
    }
    const entryMaxPages = resolveMaxPages(entry);
    // `ctx.maxPages` means verify-portals is probing, not scanning: walk one page
    // and one axis, so a liveness check costs one request instead of
    // queries x teams (providers/ADDING_A_PROVIDER.md).
    const ctxMaxPages = Number(/** @type {any} */ (ctx)?.maxPages);
    const probing = ctxMaxPages > 0;
    const maxPages = probing ? Math.min(entryMaxPages, ctxMaxPages) : entryMaxPages;
    /** @type {Record<string,string>[]} */
    const axes = [
      ...queries.map((q) => ({ search: q, location, sort: 'relevance' })),
      ...teams.map((t) => ({ location, team: t })),
    ];
    if (probing) axes.length = 1;

    /** @type {Map<string, Job>} */
    const byUrl = new Map();
    let truncated = false;

    /** Page through one search axis, stopping early on the last page. */
    const harvest = async (/** @type {Record<string,string>} */ base) => {
      for (let page = 1; page <= maxPages; page++) {
        const url = searchUrl({ ...base, page: String(page) });
        assertAppleUrl(url);
        if (page > 1) await sleep(INTER_PAGE_DELAY_MS, ctx);
        let html;
        try {
          html = await fetchTextWithRetry(ctx, url, { redirect: 'error' });
        } catch (err) {
          // Recall-first during a scan: keep the axes already collected rather
          // than losing the whole board to one bad search. While PROBING the
          // rejection must propagate unwrapped, or verify-portals reads its own
          // request-budget sentinel as a broken board.
          if (probing) throw err;
          return;
        }
        // Throws on a changed page shape rather than returning what we have: a
        // silent 0 reads as "no matching roles" forever, where a descriptive
        // error names the page that stopped parsing (parseIbmResponse in
        // providers/ibm.mjs is the precedent).
        const { jobs, rowCount, total } = parseSearchPage(html, url, entry.name);
        for (const job of jobs) if (!byUrl.has(job.url)) byUrl.set(job.url, job);
        if (rowCount < PAGE_SIZE || page * PAGE_SIZE >= total) return;
        if (page === maxPages && !probing) truncated = true;
      }
    };

    for (const axis of axes) await harvest(axis);
    if (truncated) {
      console.error(`⚠️  apple: ${entry.name} hit the ${maxPages}-page cap on at least one search — raise max_pages on this entry for more`);
    }

    const result = [...byUrl.values()];
    // Canonical partial-read signal (lib/board-truncation.mjs): scan.mjs logs
    // this board `partial` instead of `reachable`.
    if (truncated) /** @type {any} */ (result).truncated = { reason: 'page-cap', fetched: result.length };
    return result;
  },
};
