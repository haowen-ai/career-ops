// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// iCIMS provider — scrapes the public hosted-portal search pages.
// Auto-detects from careers_url on any `*.icims.com` https host
// (canonical form: `https://careers-<tenant>.icims.com/jobs/search?ss=1`).
//
// iCIMS list pages carry title/location/URL but no dates. Posted and close
// dates live on the job detail page's JSON-LD (`datePosted`, `validThrough`).
// The provider therefore returns undated jobs plus an `enrichDate(job, ctx)`
// hook — scan-ats-full.mjs calls it only for jobs that already passed the
// cheap title/location filters, so a 10k-tenant sweep pays detail-page
// requests for real candidates only, never for noise.

import { BROWSER_LIKE_USER_AGENT, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';
import { closesAtIso } from '../lib/posting-close.mjs';

// Page cap per search. Tenants show 20–50 postings/page (Emcor and BrightSpring
// show 50, 2026-11-11), so 30 pages is 600–1,500 postings. Boards bigger than
// that (Emcor 31 pages, BrightSpring 41) are read through keyword mode below
// when the caller passes entry.keywords; without keywords the cap tags the
// result icimsTruncated.
const ICIMS_MAX_PAGES = 30;
// Same per-tenant courtesy delay as workday.mjs — only multi-page tenants pay it.
const INTER_PAGE_DELAY_MS = 250;

// iCIMS serves 200 directly to a browser-like UA (verified live); the default
// career-ops UA risks WAF interstitials, same as workday/glints.
const HEADERS = {
  'user-agent': BROWSER_LIKE_USER_AGENT,
  'accept-language': 'en-US,en;q=0.9',
};

function resolveOrigin(entry) {
  // entry.api takes precedence over careers_url (mirrors greenhouse/ashby).
  for (const raw of [entry.api, entry.careers_url]) {
    if (typeof raw !== 'string' || !raw) continue;
    let parsed;
    try { parsed = new URL(raw); } catch { continue; }
    if (parsed.protocol !== 'https:') continue;
    if (!parsed.hostname.endsWith('.icims.com')) continue;
    return parsed.origin;
  }
  return null;
}

// in_iframe=1 selects the lighter portal-only markup; pr is the 0-based page.
const searchUrl = (origin, page) => `${origin}/jobs/search?ss=1&pr=${page}&in_iframe=1`;
// The same search page filtered by the portal's own keyword box
// (`searchKeyword=`, verified live 2026-11-11 on Emcor: unfiltered 31 pages,
// "intern" 20 hits on 1 page, a nonsense word 0). The portal's default
// relation is keyword_all, so a multi-word term ANDs its words
// ("early career" 4 hits vs "early" 20 / "career" 46) and is sent as-is.
const keywordUrl = (origin, term, page) =>
  `${origin}/jobs/search?ss=1&searchKeyword=${encodeURIComponent(term)}&pr=${page}&in_iframe=1`;

/**
 * Parse one iCIMS search-results page. Exported for unit tests.
 *
 * Postings are `<li class="iCIMS_JobCardItem">` cards: posting URL in an
 * `iCIMS_Anchor` href (`/jobs/{id}/{title-slug}/job`, query stripped), title
 * in the anchor's `<h3>`, location in the span following a `field-label`
 * whose text starts with the word Location ("Location", "Location : Country").
 * Cards whose href resolves off-origin are
 * dropped (defense in depth —
 * a portal page should never link a posting on another host).
 *
 * @param {string} html
 * @param {string} origin   e.g. "https://careers-acme.icims.com"
 * @param {string} companyName
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseIcimsSearchPage(html, origin, companyName) {
  const jobs = [];
  const cards = String(html).split('iCIMS_JobCardItem').slice(1);
  for (const card of cards) {
    const href = card.match(/href="([^"]*\/jobs\/\d+\/[^"/]+\/job[^"]*)"/);
    if (!href) continue;
    let parsed;
    // Resolve against the portal origin so a documented *relative* posting href
    // (/jobs/{id}/{slug}/job) isn't silently dropped — some tenants emit those,
    // and dropping them all would make fetch() return zero jobs with no error.
    // The origin check below still rejects any link that resolves off-host.
    try { parsed = new URL(decodeEntities(href[1]), origin); } catch { continue; }
    if (parsed.origin !== origin) continue;
    // Match the tags with attributes allowed: tenants theme their portals, and a
    // themed <h3 class="..."> under a bare-tag-only regex would drop the card
    // silently — zero jobs, no error, indistinguishable from an empty board.
    const title = card.match(/<h3\b[^>]*>\s*([\s\S]*?)<\/h3>/);
    if (!title || !title[1].trim()) continue;
    // `field-label` is one token in a themed class list, not reliably the last
    // one, so anchoring on the literal `field-label">` read an empty location
    // off any tenant that appended a class.
    // The lookarounds keep `field-label` a whole token, so a longer hyphenated
    // class like `field-label-inline` still doesn't count as a match.
    // The label text has to start with the word Location. Tenants suffix it
    // ("Location : Country", "Location : City") and put the value in the next
    // span. Requiring the span to contain only "Location" left those boards
    // blank. "Locations" does not match: the word boundary stops it.
    const location = card.match(/<span\b[^>]*class=["'][^"']*(?<![\w-])field-label(?![\w-])[^"']*["'][^>]*>\s*Location\b[^<]*<\/span>\s*<span\b[^>]*>\s*([\s\S]*?)<\/span>/);
    jobs.push({
      title: decodeEntities(title[1].replace(/\s+/g, ' ').trim()),
      url: `${parsed.origin}${parsed.pathname}`,
      company: companyName,
      location: location ? decodeEntities(location[1].replace(/\s+/g, ' ').trim()) : '',
      // no postedAt — iCIMS list pages have no date; see enrichDate.
    });
  }
  return jobs;
}

/**
 * Read "Page X of N" from an iCIMS search page's results header; null when
 * the page carries no pager (no results, or a layout we do not know).
 * Exported for unit tests.
 * @param {string} html
 * @returns {number|null}
 */
export function parseIcimsPageCount(html) {
  const m = String(html || '').match(/\bPage\s+\d[\d,]*\s+of\s+(\d[\d,]*)/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Normalise entry.keywords to a de-duplicated list of non-empty terms. @param {unknown} raw */
export function normalizeKeywords(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const out = [];
  for (const k of list) {
    if (typeof k !== 'string') continue;
    const t = k.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

// Walk the result pages of one search (urlFor(page) builds the page URL).
// Stops on an empty page, on a page that repeats the previous first posting
// (tenants that serve the last page again for an out-of-range pr), at the
// pager's last page when `usePager` is set, or at ICIMS_MAX_PAGES — the only
// stop that means "capped".
async function crawl(entry, origin, ctx, urlFor, { usePager = false } = {}) {
  const jobs = [];
  let prevFirstUrl = null;
  let reachedEnd = false;
  for (let pageNum = 0; pageNum < ICIMS_MAX_PAGES; pageNum++) {
    if (pageNum > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
    let html;
    try {
      html = await ctx.fetchText(urlFor(pageNum), { headers: HEADERS, redirect: 'error' });
    } catch (err) {
      // Only a first-page failure says anything about whether this host has a
      // board at all; fetchFull() uses the mark to decide on a fallback host.
      // Later pages are marked explicitly false, so dead-board tracking can tell
      // "this board had already answered" apart (upstream #5045).
      if (err && typeof err === 'object') err.firstPage = pageNum === 0;
      throw err;
    }
    const pageJobs = parseIcimsSearchPage(html, origin, entry.name);
    if (pageJobs.length === 0) { reachedEnd = true; break; } // past the last page
    if (pageJobs[0].url === prevFirstUrl) { reachedEnd = true; break; }
    prevFirstUrl = pageJobs[0].url;
    jobs.push(...pageJobs);
    if (usePager) {
      const pages = parseIcimsPageCount(html);
      if (pages !== null && pageNum + 1 >= pages) { reachedEnd = true; break; }
    }
  }
  return { jobs, capped: !reachedEnd };
}

// The whole-board read (no keywords): unchanged behaviour, including the
// icimsTruncated tag when the page cap stops it. Exhausting the cap silently
// would drop every later posting and look identical to a complete board —
// the same failure mode the Workday truncation tag exists to prevent.
// `origins` = the primary host, then entry.fallback_urls hosts (upstream): a host
// whose FIRST page answers 404 hands over to the next one.
async function fetchFull(entry, origins, ctx) {
  let notFound;
  for (const origin of origins) {
    try {
      const { jobs, capped } = await crawl(entry, origin, ctx, (page) => searchUrl(origin, page));
      if (capped) jobs.icimsTruncated = true;
      return jobs;
    } catch (err) {
      if (err?.status !== 404 || !err.firstPage) throw err;
      notFound = err;
    }
  }
  throw notFound;
}

// Board size from the pager (see fetch). null = pager unreadable but the
// board has cards; 0 = no cards on page 0.
async function readBoardTotal(entry, origin, ctx) {
  const first = await ctx.fetchText(searchUrl(origin, 0), { headers: HEADERS, redirect: 'error' });
  const perPage = parseIcimsSearchPage(first, origin, entry.name).length;
  if (perPage === 0) return 0;
  const pages = parseIcimsPageCount(first);
  if (pages === null) return null;
  if (pages === 1) return perPage;
  await sleep(INTER_PAGE_DELAY_MS, ctx);
  const last = await ctx.fetchText(searchUrl(origin, pages - 1), { headers: HEADERS, redirect: 'error' });
  const lastCount = parseIcimsSearchPage(last, origin, entry.name).length;
  // An unreadable last page still leaves a sound lower bound.
  return (pages - 1) * perPage + (lastCount || 1);
}

// One keyword search per term, merged in term order then page order and
// de-duplicated by posting URL (it carries the iCIMS job id). The array
// carries keywordSearch for the caller; a term that hits the page cap marks
// the whole result truncated. The portal search matches words anywhere in a
// posting ("intern" also finds "Internal Lead Generator"), so the result is a
// superset that the normal title filters narrow later.
async function fetchByKeywords(entry, origin, ctx, terms, boardTotal) {
  const jobs = [];
  const seen = new Set();
  const perTerm = {};
  let truncated = false;
  for (let i = 0; i < terms.length; i++) {
    if (i > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
    const term = terms[i];
    const r = await crawl(entry, origin, ctx, (page) => keywordUrl(origin, term, page), { usePager: true });
    perTerm[term] = r.jobs.length;
    if (r.capped) truncated = true;
    for (const job of r.jobs) {
      if (seen.has(job.url)) continue;
      seen.add(job.url);
      jobs.push(job);
    }
  }
  Object.defineProperty(jobs, 'keywordSearch', {
    value: { mode: 'keywords', terms: terms.length, boardTotal, perTerm },
    enumerable: true, writable: true, configurable: true,
  });
  if (truncated) jobs.truncated = true;
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'icims',

  detect(entry) {
    const origin = resolveOrigin(entry);
    return origin ? { url: searchUrl(origin, 0) } : null;
  },

  /**
   * Walk a tenant's search pages. An entry may carry `fallback_urls`: other
   * hosts the same tenant could be served from (scan-ats-full.mjs builds them,
   * because the public dataset stores some tenants bare and some as a full
   * portal subdomain). A fallback is tried only when the previous host answers
   * 404 on its FIRST page, the one response that means "no board here". Any
   * other failure (throttle, timeout, DNS, a later-page 404) is rethrown as-is.
   * A first-page throttle or timeout carries its own status, which dead-board
   * tracking reads as "unknown". A later-page failure carries `firstPage:
   * false`, which is how tracking knows the board had already answered and
   * does not count a later-page 404 as a miss (recordBoardFailure()).
   */
  async fetch(entry, ctx) {
    const origin = resolveOrigin(entry);
    if (!origin) throw new Error(`icims: cannot derive portal origin for ${entry.name}`);
    const origins = [origin];
    for (const raw of Array.isArray(entry.fallback_urls) ? entry.fallback_urls : []) {
      // Same https + *.icims.com gate as the primary: a fallback can never
      // point the scanner at another host.
      const fallback = resolveOrigin({ careers_url: raw });
      if (fallback && !origins.includes(fallback)) origins.push(fallback);
    }
    const terms = normalizeKeywords(entry.keywords);
    // No terms, or a health probe (ctx.maxPages: is the board live?): the
    // whole-board read exactly as before keyword mode existed.
    if (!terms.length || (Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0)) return fetchFull(entry, origins, ctx);

    // keyword_min_total keeps small boards on the full read. iCIMS shows no
    // result count, only the pager ("Search Results Page 1 of 31") and a fixed
    // number of cards per page, so the size is read from page 0's pager plus
    // the last page: (pages - 1) × cards-per-page + cards on the last page.
    // A board with no readable pager but with cards counts as bigger than the
    // threshold (same rule as successfactors' missing count); a board with no
    // cards at all is empty and stays on the full read.
    const minTotal = Number.isInteger(entry.keyword_min_total) && entry.keyword_min_total > 0 ? entry.keyword_min_total : null;
    let boardTotal = null;
    if (minTotal !== null) {
      boardTotal = await readBoardTotal(entry, origin, ctx);
      if (boardTotal === 0 || (boardTotal !== null && boardTotal <= minTotal)) {
        await sleep(INTER_PAGE_DELAY_MS, ctx);
        return fetchFull(entry, origins, ctx);
      }
      await sleep(INTER_PAGE_DELAY_MS, ctx);
    }
    return fetchByKeywords(entry, origin, ctx, terms, boardTotal);
  },

  /**
   * Fill in job.postedAt from the posting's detail page (JSON-LD JobPosting
   * `datePosted`) — the list pages carry no date at all. A real `validThrough`
   * on that same node becomes job.closesAt. Any failure leaves the job
   * undated; the caller's undated policy then applies as usual.
   *
   * The same detail page also carries `jobLocation.address`, so an empty
   * list-page location is filled here too. Several tenants render the search
   * card without a location span at all; the empty string that produced then
   * passes location_filter (an empty location can't match a block term), so a
   * US-only board reaches the results with no country attached and the reader
   * has to look each posting up by hand. Measured 2026-08-13: all six iCIMS
   * matches in a 1,000-company sweep were US postings that arrived this way.
   */
  async enrichDate(job, ctx) {
    const sep = job.url.includes('?') ? '&' : '?';
    const html = await ctx.fetchText(`${job.url}${sep}in_iframe=1`, { headers: HEADERS, redirect: 'error' });
    const nodes = [];
    // `type` is not reliably the first attribute: a tenant running CSP emits a
    // nonce on every inline script. Requiring it first found no date at all,
    // leaving every posting on that board undated — the undated policy then
    // drops them and a working board looks identical to an empty one.
    for (const [, raw] of String(html).matchAll(/<script\b[^>]*(?<![\w-])type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      let data;
      try { data = JSON.parse(raw); } catch { continue; }
      // Flatten the JSON-LD shapes iCIMS / schema.org emit: a bare JobPosting
      // object, an array of nodes, or a graph document ({"@graph":[...]}).
      if (Array.isArray(data)) nodes.push(...data);
      else if (Array.isArray(data?.['@graph'])) nodes.push(...data['@graph']);
      else nodes.push(data);
    }
    const ts = Date.parse(pickDatePosted(nodes) || '');
    if (!Number.isNaN(ts)) job.postedAt = ts;
    const closesAt = pickClosesAt(nodes);
    if (closesAt) job.closesAt = closesAt;
    if (!String(job.location || '').trim() || /^n\/?a$/i.test(String(job.location).trim())) {
      const loc = pickLocation(nodes);
      if (loc) job.location = loc;
    }
  },
};

// ISO country codes are what iCIMS emits, but location_filter matches on the
// words a human wrote in portals.yml ("Canada", "United States"), so a bare
// "US" would sail past a block list that spells the country out.
const COUNTRY_NAMES = { US: 'United States', CA: 'Canada' };

// From flattened JSON-LD nodes, build "Locality, Region, Country" out of the
// first jobLocation entry (across all JobPosting nodes) that yields any usable
// parts. Some tenants emit an all-UNAVAILABLE entry ahead of the real address,
// so reading only the first entry would return no location even though a
// later one has one. Partial addresses are kept: the country alone is already
// enough for location_filter to decide.
function pickLocation(nodes) {
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || !node.jobLocation) continue;
    const places = Array.isArray(node.jobLocation) ? node.jobLocation : [node.jobLocation];
    for (const place of places) {
      const addr = place?.address;
      if (!addr || typeof addr !== 'object') continue;
      const clean = v => {
        const s = String(v ?? '').trim();
        // iCIMS writes the literal string UNAVAILABLE into fields it has no value
        // for, so an unchecked join yields "UNAVAILABLE, MD, United States".
        return !s || /^unavailable$/i.test(s) ? '' : s;
      };
      const country = clean(addr.addressCountry);
      const parts = [
        clean(addr.addressLocality),
        clean(addr.addressRegion),
        COUNTRY_NAMES[country.toUpperCase()] || country,
      ].filter(Boolean);
      if (parts.length) return parts.join(', ');
    }
  }
  return null;
}

function jobPostingType(node) {
  const type = node?.['@type'];
  return type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
}

function datedPostingNode(nodes) {
  let fallback = null;
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || !node.datePosted) continue;
    if (jobPostingType(node)) return node;
    if (fallback == null) fallback = node;
  }
  return fallback;
}

function pickDatePosted(nodes) {
  const node = datedPostingNode(nodes);
  return node ? node.datePosted : null;
}

function pickClosesAt(nodes) {
  const posted = datedPostingNode(nodes);
  if (posted) return closesAtIso(posted) || '';
  let fallback = '';
  let sawTyped = false;
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const day = closesAtIso(node);
    if (jobPostingType(node)) {
      sawTyped = true;
      if (day) return day;
      continue;
    }
    if (!fallback && day) fallback = day;
  }
  return sawTyped ? '' : fallback;
}
