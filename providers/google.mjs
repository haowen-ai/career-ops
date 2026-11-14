// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
import { coerceId } from './_ids.mjs';
import { htmlToText } from './_html-to-text.mjs';
import { BROWSER_LIKE_USER_AGENT, fetchTextWithRetry, sleep } from './_http.mjs';
import { markTruncated } from '../lib/board-truncation.mjs';

// Google provider — Google Careers is server-rendered, so the results page HTML
// contains every job link:
//   GET https://www.google.com/about/careers/applications/jobs/results/?q=<kw>&location=United%20States&sort_by=date
//   -> HTML with one card per posting, closed by <a href="jobs/results/{id}-{slug}">
// No JSON API and no XHR (data is in the document), so we run phrase queries and
// let scan.mjs's title filter cut.
//
// Each card carries the posting's real title (<h3>) and an "Employer | location;
// location; +2 more" line. The EMPLOYER is not always Google: the same results
// list YouTube, DeepMind and other Alphabet companies' postings, so the card's
// employer is the company, not the portals.yml entry name (CodeRabbit, #4078).
// A card without that markup falls back to the entry name, the link's
// aria-label or slug for the title, and a blank location.
//
// PAGINATION. The results are paged with a 1-based `page` query parameter
// (omitted on page 1), 20 cards per full page, newest first under
// `sort_by=date`. Until 2026-11-08 this provider read only the first page,
// because `google.com/robots.txt` disallows the `page=` results URLs; rule 6 of
// the Source Indexing Policy stopped treating robots.txt as a gate (#6691,
// #6694), so the walk now continues page by page. A query ends on the first
// empty page, a page that repeats one already seen in the same walk, or a short
// page (fewer than a full page of cards), and is otherwise bounded by
// `max_pages` per query (default DEFAULT_MAX_PAGES, hard ceiling MAX_PAGES_CAP).
//
// Config (portals.yml):
//   provider: google
//   google:
//     location: "United States"      # optional
//     queries: ["business strategy", "business operations", ...]
//   max_pages: 10                     # optional, per query

const BASE = 'https://www.google.com/about/careers/applications/jobs/results/';
// A full results page carries 20 cards; a shorter page is the last one for that
// query. Observed live 2026-11-08.
const PAGE_SIZE = 20;
const DEFAULT_MAX_PAGES = 10; // 200 postings per query
const MAX_PAGES_CAP = 50; // hard ceiling even for a max_pages override
const INTER_PAGE_DELAY_MS = 400;
// The anchor that closes each card; the markup since the previous anchor is that
// card. Google serves the href relative ("jobs/results/…"); a path prefix is
// tolerated, and the URL is rebuilt from BASE either way.
const ANCHOR_RE = /<a\b[^>]*?\bhref="(?:[^"]*\/)?jobs\/results\/(\d+)-([a-z0-9-]+)[^"]*"[^>]*>/g;
const H3_RE = /<h3\b[^>]*>([^<]+)<\/h3>/g;
const EMPLOYER_LINE_RE = /<p class="l103df">([\s\S]*?)<\/p>/g;
const ARIA_TITLE_RE = /\baria-label="Learn more about ([^"]+)"/;
// "+2 more" is Google collapsing the rest of the list, not a place.
const MORE_RE = /^\+\d+ more$/;
const DEFAULT_QUERIES = [
  'business strategy', 'business operations', 'strategy and operations',
  'corporate development', 'financial planning',
];

function getConfig(entry) {
  const c = entry.google || {};
  const queries = Array.isArray(c.queries) && c.queries.length ? c.queries : DEFAULT_QUERIES;
  return { location: c.location || 'United States', queries };
}

/** @param {any} entry @returns {number} */
export function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

function titleFromSlug(slug) {
  return slug.replace(/-/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Card text goes through the shared pipeline, never a local strip-then-decode:
// stripping tags before decoding lets "&lt;script&gt;" come back out as a live
// "<script>" (CodeQL js/incomplete-multi-character-sanitization on #4078).
const text = (/** @type {string} */ s) => htmlToText(s);

/** Last match of a global regex in `s`, or null. */
function lastMatch(/** @type {RegExp} */ re, /** @type {string} */ s) {
  let last = null;
  for (const m of s.matchAll(re)) last = m;
  return last;
}

/**
 * Parse one results page into its cards.
 *
 * @param {string} html
 * @returns {{id: string, slug: string, title: string, employer: string, locations: string[]}[]}
 */
export function parseResultsPage(html) {
  const cards = [];
  let prevEnd = 0;
  for (const a of String(html).matchAll(ANCHOR_RE)) {
    const [tag, id, slug] = a;
    const card = html.slice(prevEnd, a.index);
    prevEnd = /** @type {number} */ (a.index) + tag.length;
    const h3 = lastMatch(H3_RE, card);
    const aria = tag.match(ARIA_TITLE_RE);
    const title = (h3 && text(h3[1])) || (aria && text(aria[1])) || titleFromSlug(slug);
    const line = lastMatch(EMPLOYER_LINE_RE, card);
    let employer = '';
    let locations = [];
    if (line) {
      const sep = line[1].indexOf('|');
      if (sep !== -1) {
        employer = text(line[1].slice(0, sep));
        locations = text(line[1].slice(sep + 1)).split(';').map((l) => l.trim()).filter((l) => l && !MORE_RE.test(l));
      }
    }
    cards.push({ id, slug, title, employer, locations });
  }
  return cards;
}

// ── Whole-board mode (career-journal fork) ─────────────────────────────
const BOARD_HOST = 'www.google.com';
const BOARD_PATH = '/about/careers/applications/jobs/results/';
const ALLOWED_PARAMS = new Set([
  'location', 'q', 'target_level', 'employment_type', 'degree', 'company',
  'skills', 'has_remote', 'sort_by', 'distance', 'jex',
]);
const BOARD_DEFAULT_MAX_PAGES = 150;
const BOARD_MAX_PAGES_CAP = 500;
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
  if (u.hostname.toLowerCase() !== BOARD_HOST) throw new Error(`google: host not allowed: ${u.hostname}`);
  if (u.username || u.password || u.port) throw new Error('google: credentials/port not allowed in careers_url');
  const path = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
  if (path !== BOARD_PATH) throw new Error(`google: careers_url path must be ${BOARD_PATH}, got ${u.pathname}`);
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
  return `https://${BOARD_HOST}${BOARD_PATH}${qs ? `?${qs}` : ''}`;
}

/** @param {string} url */
function assertGoogleUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== BOARD_HOST || !u.pathname.startsWith(BOARD_PATH)) {
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
export function parseResultsIsland(data, companyName) {
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
        url: `https://${BOARD_HOST}${BOARD_PATH}${id}${slug ? `-${slug}` : ''}`,
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
function resolveBoardMaxPages(entry, ctx) {
  const v = entry?.max_pages;
  const fromEntry = Number.isInteger(v) && v > 0 ? Math.min(v, BOARD_MAX_PAGES_CAP) : BOARD_DEFAULT_MAX_PAGES;
  const hint = Number(ctx?.maxPages);
  return Number.isFinite(hint) && hint > 0 ? Math.min(fromEntry, Math.floor(hint)) : fromEntry;
}

// Whole-board mode (career-journal fork): an entry with no `google:` block whose careers_url
// carries the site's own filters (e.g. ?location=United%20States) reads every row of that
// filtered board from the ds:1 data island, 20 per page, bounded by max_pages (default 150).
/** @param {any} entry @param {any} ctx */
async function fetchBoard(entry, ctx) {
  const cfg = resolveConfig(entry); // throws before any request
  const maxPages = resolveBoardMaxPages(entry, ctx);
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
    const res = parseResultsIsland(extractResultsIsland(html), entry.name);
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
    markTruncated(all, pagesFetched >= maxPages ? 'page-cap' : 'source-reports-more', { fetched: all.length, total });
  }
  return all;
}

/** Whole-board mode applies: no google: block, careers_url on the results path with filters. @param {any} entry */
function boardMode(entry) {
  if (entry?.google) return false;
  try {
    const raw = entry?.careers_url || entry?.api;
    if (typeof raw !== 'string') return false;
    resolveConfig({ careers_url: raw });
    return [...new URL(raw).searchParams.keys()].some((k) => k !== 'page');
  } catch { return false; }
}

/** @type {Provider} */

export default {
  id: 'google',

  detect(entry) {
    if (entry.google) return { url: BASE };
    if (!boardMode(entry)) return null;
    return { url: buildPageUrl(resolveConfig(entry), 1) };
  },

  async fetch(entry, ctx) {
    if (boardMode(entry)) return fetchBoard(entry, ctx);
    const { location, queries } = getConfig(entry);
    // `ctx.maxPages` means verify-portals is probing, not scanning: walk one
    // query and one page, so a liveness check costs one request instead of
    // queries x pages (providers/ADDING_A_PROVIDER.md).
    const ctxMaxPages = Number(/** @type {any} */ (ctx)?.maxPages);
    const probing = ctxMaxPages > 0;
    const entryMaxPages = resolveMaxPages(entry);
    const maxPages = probing ? Math.min(entryMaxPages, ctxMaxPages) : entryMaxPages;
    const queriesToRun = probing ? queries.slice(0, 1) : queries;

    const byId = new Map();
    let requestsMade = 0;
    let truncated = false;
    let fetchFailed = false;
    let firstPageFailures = 0;
    let firstPageError;

    for (const q of queriesToRun) {
      // IDs seen in THIS query's walk: a page that adds none is Google
      // re-serving an earlier page past the end, so the walk for this query
      // stops — but a later query whose first page overlaps an earlier query
      // still walks its own deeper pages (ADDING_A_PROVIDER.md).
      const seenThisQuery = new Set();
      for (let page = 1; page <= maxPages; page++) {
        // URLSearchParams, not hand-built encodeURIComponent: q and location come from
        // portals.yml, and URLSearchParams never throws on a malformed string.
        const params = new URLSearchParams({ q: String(q), location: String(location), sort_by: 'date' });
        if (page > 1) params.set('page', String(page));
        const url = `${BASE}?${params}`;
        if (requestsMade > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
        let html;
        try {
          html = await fetchTextWithRetry(ctx, url, { redirect: 'error' });
        } catch (err) {
          // While probing, a rejection propagates unwrapped (verify-portals needs it).
          // Track page-1 failures across all queries: if every query fails on page 1,
          // throw the first error (a total outage). Otherwise, keep the jobs collected
          // from successful queries, warn, and move to the next query.
          if (probing) throw err;
          fetchFailed = true;
          if (page === 1) {
            if (firstPageFailures === 0) firstPageError = err;
            firstPageFailures += 1;
          }
          const cause = err instanceof Error ? err.message : String(err);
          console.error(`⚠️  google: ${entry.name} stopped "${q}" at page ${page} (${byId.size} jobs so far): ${cause}`);
          break;
        }
        requestsMade += 1;
        const cards = parseResultsPage(html);
        let newThisQuery = 0;
        for (const { id, slug, title, employer, locations } of cards) {
          if (!seenThisQuery.has(id)) { seenThisQuery.add(id); newThisQuery += 1; }
          if (byId.has(id)) continue;
          byId.set(id, {
            title,
            url: `${BASE}${id}-${slug}`,
            company: employer || entry.name,
            location: locations.join('; '),
            ...(coerceId(id) ? { externalId: /** @type {string} */ (coerceId(id)) } : {}),
          });
        }
        // Stop at this query's last page: empty, re-served (no new ids), or
        // short (a full page is PAGE_SIZE cards).
        if (cards.length === 0 || newThisQuery === 0 || cards.length < PAGE_SIZE) break;
        if (page === maxPages && !probing) truncated = true;
      }
    }
    if (firstPageFailures === queriesToRun.length && firstPageError) {
      throw firstPageError;
    }
    let jobs = [...byId.values()];
    if (truncated) {
      console.error(`⚠️  google: ${entry.name} hit the ${maxPages}-page cap on at least one query — raise max_pages on this entry for more`);
      jobs = markTruncated(jobs, 'page-cap', { fetched: jobs.length });
    }
    if (fetchFailed) {
      jobs = markTruncated(jobs, 'fetch-error', { fetched: jobs.length });
    }
    return jobs;
  },
};
