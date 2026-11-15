// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchJsonWithRetry, fetchResponseWithRetry, sleep } from './_http.mjs';
import { markCollection } from './_early-stop.mjs';
// Titles arrive HTML-escaped, so the tag strip below is not enough on its own:
// an undecoded "R&amp;D Engineer" fails the user's own title_filter positive
// "r&d" and is silently dropped, and a negative like "sales & marketing" never
// vetoes "Sales &amp; Marketing Lead". Shared decoder, same as softgarden and
// radancy (#2487, #2921).
import { decodeEntities } from './_html-entities.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';

// Phenom People provider — the "CareerConnect" career sites many large
// enterprises run (branded domains like careers.exampleco.com). The search
// SPA talks to a public, no-auth JSON widget endpoint on the BRANDED host:
//
//   POST {origin}/widgets
//   Content-Type: application/json
//   {"lang":"en_global","country":"global","ddoKey":"refineSearch",
//    "pageName":"search-results","siteType":"external","jobs":true,"counts":true,
//    "from":0,"size":100,"keywords":"","selected_fields":{…facet filters…},
//    "all_fields":["category","country","city"], …}
//   → {"refineSearch":{"status":200,"totalHits":N,
//        "data":{"jobs":[{"jobId":"98098","title":…,"city":…,"state":…,
//          "country":…,"location":…,"postedDate":"…ISO…","applyUrl":…}]}}}
//
// `from` is a 0-based offset; `size` up to 100/page (verified). The public job
// page the SPA links to is {origin}/{urlPrefix}/job/{jobId}/{slug} — the slug is
// cosmetic (Phenom keys on jobId; a stub slug resolves the same posting), so we
// slugify the title. applyUrl points at the downstream ATS (tenant-specific,
// observed live) and is NOT the public listing, so we don't use it as the
// job URL.
//
// Facets use human-readable values here (unlike CSOD/beesite numeric codes):
// selected_fields:{"country":["Germany"]} narrows to the DACH set. A portals
// entry configures the tenant via a `phenom:` block:
//   phenom:
//     lang: en_global        # widget locale (default en_global)
//     country: global        # widget country scope (default global)
//     urlPrefix: global/en   # public job-page path prefix (default global/en)
//     selectedFields: { country: ["Germany"] }   # optional facet filter
//
// No auto-detection: every tenant we've found (Marsh McLennan, Baker Hughes,
// Omnicable, KCE, ...) permanently 301-redirects its legacy
// <tenant>.phenompeople.com host to its own branded domain, and this
// provider's fetch() uses `redirect: 'error'` (never follows a redirect), so
// even matching that legacy host would still fail to fetch. There is no
// known live tenant reachable via a phenompeople.com URL. Always wire a
// tenant with an explicit `provider: phenom` + `careers_url` pointed at its
// branded origin (the /widgets endpoint lives on that same origin, so no
// separate `api:` is needed).

const PAGE_SIZE = 100; // max the widget serves per page (verified)

// Safety cap on pagination — applied regardless of what the widget reports as
// `totalHits`, so a misbehaving API can't drive this into fetching an
// unbounded number of pages. Override with `max_pages` on the portal entry
// for a tenant that genuinely exceeds it (mirrors providers/workday.mjs).
const DEFAULT_MAX_PAGES = 20; // 20*100 = 2,000 postings
// Hard ceiling even for an explicit override. 300 pages (30,000 postings) is
// an arbitrary 15x default headroom multiplier, NOT verified against any
// confirmed large Phenom tenant — unlike workday.mjs's identical 30,000
// figure, which is backed by three named, verified tenants (dollartree
// 23,609; oreillyauto 17,061; cvshealth ~16,800). The only Phenom tenant
// actually measured here is Allianz (~1,900), already well within
// DEFAULT_MAX_PAGES above; workday's retail/pharmacy chains post per-store
// listings at a scale nothing in this codebase's Phenom deployments (branded
// corporate HQ career sites) has been shown to reach. Revisit if a real
// tenant is found sitting near this ceiling.
const MAX_PAGES_CAP = 300;

const PAGE_DELAY_MS = 150; // polite pacing between page requests

/** @param {import('./_types.js').PortalEntry} entry */
export function resolveConfig(entry) {
  const raw = entry.api || entry.careers_url || '';
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const block = entry.phenom && typeof entry.phenom === 'object' ? entry.phenom : {};
  const urlPrefix = String(block.urlPrefix || 'global/en').replace(/^\/+|\/+$/g, '');
  return {
    origin: u.origin,
    widgetsApi: `${u.origin}/widgets`,
    lang: typeof block.lang === 'string' ? block.lang : 'en_global',
    country: typeof block.country === 'string' ? block.country : 'global',
    urlPrefix,
    selectedFields: block.selectedFields && typeof block.selectedFields === 'object' ? block.selectedFields : {},
  };
}

// Slugify a title the way Phenom builds the cosmetic job-page slug: keep
// alphanumerics, collapse every other run to a single hyphen, trim hyphens.
/** @param {string} title */
export function slugify(title) {
  return String(title)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining marks (ü→u, é→e)
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'job';
}

// Phenom postedDate is an ISO-8601 instant ("2026-05-07T18:25:30.000+0000").
/** @param {unknown} raw @returns {number | undefined} */
export function parsePhenomDate(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const ms = Date.parse(raw.trim());
  return Number.isFinite(ms) ? ms : undefined;
}

// The widget returns a flat "City, State, Country" via several fields; prefer
// the explicit `location`, else assemble from city/state/country. Strips markup
// and collapses whitespace.
/** @param {any} job @returns {string} */
export function jobLocation(job) {
  const direct = decodeEntities(String(job?.location || job?.cityStateCountry || job?.cityState || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  if (direct) return direct;
  const parts = [job?.city, job?.state, job?.country].map((p) => String(p || '').trim()).filter(Boolean);
  return [...new Set(parts)].join(', ');
}

/**
 * Map one refineSearch response to {total, rows, rawIds, anonymous, dropped}. A record without a jobId or a title is
 * skipped (no stable dedup key / no meaningful listing). rawIds lists every record's own jobId (kept or skipped), in
 * order; anonymous counts records without one; dropped lists the jobIds of records that had one but were skipped.
 * Completeness is counted on these, not on the kept rows (plan 2026-11-14 v7b r2).
 * @param {any} json @param {{origin:string, urlPrefix:string}} cfg
 */
export function parseRefineSearch(json, cfg) {
  const rs = json?.refineSearch;
  const total = typeof rs?.totalHits === 'number' ? rs.totalHits : null;
  const list = Array.isArray(rs?.data?.jobs) ? rs.data.jobs : [];
  const rows = [];
  /** @type {string[]} */ const rawIds = [];
  /** @type {string[]} */ const dropped = [];
  let anonymous = 0;
  for (const job of list) {
    const id = job && typeof job === 'object' && job.jobId != null ? String(job.jobId) : '';
    if (!id) { anonymous++; continue; }
    rawIds.push(id);
    const title = decodeEntities(String(job.title || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!title) { dropped.push(id); continue; }
    // A lone surrogate in id throws URIError out of encodeURIComponent and
    // aborts this loop; id is also the dedup key. Drop just this one.
    const encodedId = safeEncodeURIComponent(id);
    if (encodedId === null) { dropped.push(id); continue; }
    rows.push({
      id,
      title,
      url: `${cfg.origin}/${cfg.urlPrefix}/job/${encodedId}/${slugify(title)}`,
      location: jobLocation(job),
      postedAt: parsePhenomDate(job.postedDate || job.dateCreated),
    });
  }
  return { total, rows, rawIds, anonymous, dropped };
}

/**
 * Cookie jar for one walk: a Set-Cookie list updates it (name=value only; a repeated name takes its last value), and
 * header() is the Cookie request header, '' when empty.
 */
export function createCookieJar() {
  const jar = new Map();
  return {
    /** @param {unknown} setCookies */
    update(setCookies) {
      for (const raw of Array.isArray(setCookies) ? setCookies : []) {
        if (typeof raw !== 'string') continue;
        const pair = raw.split(';', 1)[0].trim();
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    header() { return [...jar].map(([name, value]) => `${name}=${value}`).join('; '); },
  };
}

/** Resolve the page cap: a positive integer `max_pages` on the entry, capped. */
export function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

// One walk is one session (plan 2026-11-14 v7b). Live 2026-11-15 on Allianz, DHL and Franklin Templeton: a /widgets
// request without a session cookie lands on one of two orderings of the same rows, at random per request, so paging
// by `from` read some rows twice and others never (Allianz 1468 of 1704, DHL 7157 of 8291, Franklin Templeton 237 of
// 260), and the old stop rule (`from` past totalHits) still called the board complete. The first response's
// Set-Cookie (PLAY_SESSION, PHPPPE_ACT) keeps every later page on the ordering that served it: 1704, 8291 and 260
// distinct jobIds, no repeats. An embedder without ctx.fetchResponse falls back to fetchJson with no cookie; the
// status below is computed the same way, so a short read there is reported, not hidden.
//
// jobs.collection.status is one of:
//   complete     every page reported the first page's totalHits, the distinct raw jobIds reached it, every row had a
//                jobId and the parser kept every row that had one;
//   page_failed  an empty page, a page of jobIds already read, the offsets ran past totalHits short of it, or a later
//                page's request failed after its retries (the rows already read are kept);
//   ceiling      max_pages (or ctx.maxPages) ran out first;
//   unverified   a page reported another totalHits (rows were added or taken down while paging, so a count cannot
//                prove coverage; the walk reads on to an empty page or the offsets' end), a row had no jobId, or a row
//                with a jobId was dropped by the parser (no title, or an id that cannot be put in a URL), or the first
//                page reported no totalHits at all (nothing to count against; the walk reads to an empty page).
// A first page that fails still throws: the list fails and nothing advances.

// One page request, retried as a whole: fetch, cookie update and JSON parse are one attempt, so an HTTP-200 body that
// is not JSON is retried like fetchJsonWithRetry retries it (a parse error carries no status, so it is retryable).
/** @param {any} ctx @param {string} url @param {any} opts @param {ReturnType<typeof createCookieJar>} jar */
async function postPage(ctx, url, opts, jar) {
  if (typeof ctx?.fetchResponse !== 'function') return fetchJsonWithRetry(ctx, url, opts);
  const attempt = {
    sleep: ctx.sleep,
    fetchResponse: async () => {
      const cookie = jar.header();
      const res = await ctx.fetchResponse(url, { ...opts, headers: { ...opts.headers, ...(cookie ? { cookie } : {}) } });
      jar.update(typeof res?.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : []);
      const text = String(await res.text()).replace(/^\uFEFF/, '');
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`phenom: ${url} did not answer JSON (HTTP ${res?.status})`);
      }
    },
  };
  return fetchResponseWithRetry(attempt, url, opts);
}

/** @type {Provider} */
export default {
  id: 'phenom',

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry);
    if (!cfg) throw new Error(`phenom: cannot resolve origin for ${entry.name}`);

    const maxPages = resolveMaxPages(entry);
    // Honor a context page cap — verify-portals' liveness probe sets
    // `ctx.maxPages: 1` so it only needs to know a board is live, not its
    // full count (mirrors providers/workday.mjs). Kept separate from
    // maxPages so the entry-cap warning below doesn't misfire when it was
    // really the probe's cap that stopped pagination.
    const ctxCap = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity;
    const pagesToFetch = Math.min(maxPages, ctxCap);
    const jar = createCookieJar();
    const jobs = [];
    const seen = new Set();
    const rawIds = new Set();
    const droppedIds = new Set();
    let anonymous = 0;
    /** @type {number|null} */
    let total = null;
    let lastTotal = null;
    let totalChanged = false;
    /** @type {null | 'count' | 'empty' | 'repeated' | 'offsets' | 'fetch-error'} */
    let end = null;
    let page = 0;
    for (; page < pagesToFetch; page++) {
      if (page > 0) await sleep(PAGE_DELAY_MS, ctx);
      let json;
      try {
        // Retries transient failures (429/5xx/timeout) with backoff before
        // giving up on the page.
        json = await postPage(ctx, cfg.widgetsApi, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            lang: cfg.lang,
            deviceType: 'desktop',
            country: cfg.country,
            pageName: 'search-results',
            ddoKey: 'refineSearch',
            sortBy: '',
            subsearch: '',
            from: page * PAGE_SIZE,
            jobs: true,
            counts: true,
            all_fields: ['category', 'country', 'city'],
            size: PAGE_SIZE,
            clearAll: false,
            jdsource: 'facets',
            isSliderEnable: false,
            pageId: 'page10',
            siteType: 'external',
            keywords: '',
            global: cfg.country === 'global',
            selected_fields: cfg.selectedFields,
            locationData: {},
          }),
        }, jar);
      } catch (err) {
        // A first page that never succeeded means a broken tenant (wrong
        // endpoint, dead board, hard-blocked): rethrow so it is a failure, not
        // "zero postings". A later page keeps the rows already read and the
        // list is page_failed.
        if (page === 0) throw err;
        const jobsSummary = `${jobs.length}${total !== null ? ` of ${total}` : ''} jobs`;
        console.error(`⚠️  phenom: ${entry.name} truncated at page ${page + 1} of ${maxPages} (${jobsSummary}): ${err.message}`);
        end = 'fetch-error';
        break;
      }
      const parsed = parseRefineSearch(json, cfg);
      // The first page's total is the target even when that page is empty: an empty page 1 of a board that reports
      // rows is a failed read, not an empty board.
      if (page === 0) total = parsed.total;
      else if (parsed.total !== total && parsed.rawIds.length + parsed.anonymous > 0) totalChanged = true;
      if (parsed.total !== null) lastTotal = parsed.total;
      if (parsed.rawIds.length + parsed.anonymous === 0) { end = 'empty'; break; }
      anonymous += parsed.anonymous;
      let freshIds = 0;
      for (const id of parsed.rawIds) if (!rawIds.has(id)) { rawIds.add(id); freshIds++; }
      for (const id of parsed.dropped) droppedIds.add(id);
      // Rows are kept before any stop below, so a page never takes away a listing it carries (a jobId dropped on an
      // earlier page for having no title is returned when a later page carries it with one).
      let freshRows = 0;
      for (const row of parsed.rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        freshRows++;
        const job = { title: row.title, url: row.url, company: entry.name, location: row.location };
        if (typeof row.postedAt === 'number') job.postedAt = row.postedAt;
        jobs.push(job);
      }
      if (page > 0 && freshIds === 0 && freshRows === 0 && parsed.anonymous === 0) { end = 'repeated'; break; }
      if (!totalChanged && total !== null && rawIds.size >= total) { end = 'count'; break; }
      // Past the last offset the board reports, further pages can only be empty.
      if (lastTotal !== null && (page + 1) * PAGE_SIZE >= lastTotal) { end = 'offsets'; break; }
    }

    // A jobId the parser dropped on one page but returned from another is not missing.
    for (const id of seen) droppedIds.delete(id);
    const short = total === null || rawIds.size < total;
    /** @type {'complete'|'page_failed'|'ceiling'|'unverified'} */
    let status;
    if (end === 'fetch-error') status = 'page_failed';
    else if (end === null && short) status = 'ceiling';
    else if (total === null || totalChanged || anonymous > 0 || droppedIds.size > 0) status = 'unverified';
    else if (short) status = 'page_failed';
    else status = 'complete';

    if (droppedIds.size > 0) console.error(`⚠️  phenom: ${entry.name} dropped ${droppedIds.size} row(s) with a jobId but no usable title or id`);
    if (anonymous > 0) console.error(`⚠️  phenom: ${entry.name} skipped ${anonymous} row(s) without a jobId`);
    if (totalChanged) console.error(`⚠️  phenom: ${entry.name} totalHits changed while paging (${total} → ${lastTotal}); ${rawIds.size} distinct jobIds read`);
    // The cap is a safety net, not a working limit — silent by design, but a
    // tenant that actually hits it needs to be surfaced (mirrors
    // providers/workday.mjs's identical "raise max_pages" warning). A
    // ctx.maxPages (probe) stop is not the entry cap and gets no advice.
    if (status === 'ceiling' && page === maxPages) {
      console.error(`⚠️  phenom: ${entry.name} truncated at max_pages=${maxPages} (${jobs.length}${total !== null ? ` of ${total}` : ''} jobs) — raise max_pages on this entry for more`);
    }
    if (status === 'page_failed' && end !== 'fetch-error') {
      console.error(`⚠️  phenom: ${entry.name} short read (${end}): ${rawIds.size} of ${total} distinct jobIds`);
      /** @type {any} */ (jobs).truncated = { reason: 'source-reports-more', fetched: jobs.length, total };
    }
    // A page cap or a failed page leaves the board partial; tag it (the workdayTruncated convention)
    // so a caller can tell without reading stderr.
    if ((status === 'ceiling' && page === maxPages) || end === 'fetch-error') /** @type {any} */ (jobs).phenomTruncated = true;

    return markCollection(jobs, status);
  },
};
