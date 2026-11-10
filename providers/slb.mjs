// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchTextWithRetry, fetchJsonWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

// SLB (Schlumberger) careers provider (→ tracked_companies:).
//
// careers.slb.com/job-listing is a Coveo Atomic search page (verified live
// 2026-11-07). The page carries the anonymous, search-only Coveo key that the
// browser uses, in hidden inputs:
//
//   <input type="hidden" id="organizationId" value="schlumbergerproduction0cs2zrh7" />
//   <input type="hidden" id="accessToken"    value="xx…-…" />          (public search key)
//   <input type="hidden" id="searchHub"      value="CoveoJobsHub" />
//   <input type="hidden" id="searchsource"   value="ATS_Jobs_Source - Prod" />
//   <atomic-search-interface … pipeline="ATSJobsPipeline" …>
//
// js-atomic-job-listing-search.js then searches with cq = @source=="<searchsource>"
// and the country facet (field "country", URL param f-country-job). We replay
// that one search against the Coveo REST API:
//
//   POST https://<org>.org.coveo.com/rest/search/v2?organizationId=<org>
//        Authorization: Bearer <accessToken>
//        { cq, aq: '@country=="United States"', searchHub, pipeline,
//          numberOfResults, firstResult, fieldsToInclude }
//   → { totalCount: 327, results: [{ title, clickUri:
//        "https://careers.slb.com/jobdescription.aspx?id=WDR00136646",
//        raw: { city: "Vernal", country: ["United States"], jobposteddate: 1793865600000 } }] }
//
// The index merges SLB's Eightfold requisitions (id=EF…) and Workday
// requisitions of acquired ChampionX (id=WDR…), so neither ATS alone covers
// the board — this provider reads the one combined index the site uses.
//
// - The key is read from the page on every run; nothing is stored here.
// - careers_url host pinned to careers.slb.com; the Coveo host is built only
//   from an organization id matching /^[a-z0-9]+$/.
// - careers_url params honoured like the page reads them (query string or
//   #hash): f-country-job (comma list), f-category-job, q.

const ALLOWED_HOSTS = new Set(['careers.slb.com']);
const SITE_ORIGIN = 'https://careers.slb.com';
const PAGE_PATH = '/job-listing';
const PAGE_SIZE = 200;
const DEFAULT_MAX_PAGES = 10; // 2,000 rows — the global board is ~1,500
const MAX_PAGES_CAP = 25; // Coveo refuses firstResult past 5,000
const INTER_PAGE_DELAY_MS = 200;
const TIMEOUT_MS = 30_000;
const FIELDS = ['title', 'country', 'city', 'jobposteddate', 'date'];

/**
 * Validate careers_url and read the facet/query params from query or hash.
 * @param {any} entry
 */
export function resolveConfig(entry) {
  const raw = entry?.careers_url || entry?.api;
  if (typeof raw !== 'string' || !raw) throw new Error('slb: careers_url is required');
  const u = new URL(raw); // throws on malformed input
  if (u.protocol !== 'https:') throw new Error(`slb: refusing non-https URL ${u.protocol}`);
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) throw new Error(`slb: host not allowed: ${u.hostname}`);
  const hash = new URLSearchParams(u.hash ? u.hash.slice(1) : '');
  const get = (k) => hash.get(k) || u.searchParams.get(k) || '';
  const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
  return {
    countries: list(get('f-country-job')),
    categories: list(get('f-category-job') || get('f-discipline-job')),
    q: get('q').trim(),
  };
}

/**
 * Pull the Coveo search settings out of the job-listing page.
 * Throws when any is missing or malformed (page changed / blocked).
 * @param {unknown} html
 */
export function extractCoveoSettings(html) {
  if (typeof html !== 'string') throw new Error('slb: job-listing page body is not text');
  const input = (id) => {
    const m = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*value="([^"]*)"`)) || html.match(new RegExp(`<input[^>]*value="([^"]*)"[^>]*id="${id}"`));
    return m ? decodeEntities(m[1]).trim() : '';
  };
  const orgId = input('organizationId');
  const accessToken = input('accessToken');
  const searchHub = input('searchHub');
  const source = input('searchsource');
  const pipeline = (html.match(/<atomic-search-interface[^>]*\spipeline="([^"]*)"/)?.[1] || '').trim();
  if (!orgId || !accessToken || !source) {
    throw new Error(`slb: Coveo settings not found on job-listing page (organizationId:${orgId ? 'ok' : 'missing'}, accessToken:${accessToken ? 'ok' : 'missing'}, searchsource:${source ? 'ok' : 'missing'})`);
  }
  if (!/^[a-z0-9]{1,64}$/.test(orgId)) throw new Error('slb: unexpected Coveo organizationId format');
  if (!/^[A-Za-z0-9-]{8,80}$/.test(accessToken)) throw new Error('slb: unexpected Coveo access key format');
  return { orgId, accessToken, searchHub, source, pipeline };
}

/** @param {string} v */
function coveoQuote(v) {
  return `"${v.replace(/["\\]/g, '')}"`;
}

/**
 * Build the Coveo search request (URL + JSON body).
 * @param {{orgId:string, accessToken:string, searchHub:string, source:string, pipeline:string}} s
 * @param {{countries:string[], categories:string[], q:string}} cfg
 * @param {number} firstResult
 */
export function buildSearchRequest(s, cfg, firstResult) {
  const aq = [];
  if (cfg.countries.length) aq.push(`@country==(${cfg.countries.map(coveoQuote).join(',')})`);
  if (cfg.categories.length) aq.push(`@hierarchicalcategory==(${cfg.categories.map(coveoQuote).join(',')})`);
  const body = {
    q: cfg.q,
    cq: `@source==${coveoQuote(s.source)}`,
    numberOfResults: PAGE_SIZE,
    firstResult,
    sortCriteria: 'date descending',
    fieldsToInclude: FIELDS,
  };
  if (aq.length) body.aq = aq.join(' ');
  if (s.searchHub) body.searchHub = s.searchHub;
  if (s.pipeline) body.pipeline = s.pipeline;
  return {
    url: `https://${s.orgId}.org.coveo.com/rest/search/v2?organizationId=${s.orgId}`,
    body,
  };
}

/** @param {unknown} v */
function firstText(v) {
  if (Array.isArray(v)) return v.map(firstText).filter(Boolean).join(' / ');
  return typeof v === 'string' ? decodeEntities(v).replace(/\s+/g, ' ').trim() : '';
}

/** @param {unknown} v */
function toEpochMs(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  return undefined;
}

/**
 * Parse one Coveo search response.
 * - error envelope ({statusCode|exception|message} without results) → throw
 * - results missing / not an array → throw (shape changed)
 * - results: [] → empty page
 * @param {any} json
 */
export function parseSearchResponse(json) {
  if (json == null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(`slb: unexpected Coveo response (${json === null ? 'null' : Array.isArray(json) ? 'array' : typeof json})`);
  }
  if (!('results' in json)) {
    const msg = typeof json.message === 'string' ? json.message : typeof json.exception?.code === 'string' ? json.exception.code : '';
    throw new Error(`slb: unexpected Coveo response${msg ? ` (${msg})` : ''} (keys: ${Object.keys(json).slice(0, 8).join(', ')})`);
  }
  if (!Array.isArray(json.results)) throw new Error('slb: unexpected Coveo response (results is not an array)');
  const total = Number.isInteger(json.totalCount) && json.totalCount >= 0 ? json.totalCount : null;
  const rows = [];
  for (const r of json.results) {
    if (!r || typeof r !== 'object') continue;
    const raw = r.raw && typeof r.raw === 'object' ? r.raw : {};
    const title = firstText(r.title) || firstText(raw.title);
    if (!title || typeof r.clickUri !== 'string') continue;
    let url;
    try {
      const u = new URL(r.clickUri);
      if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname.toLowerCase())) continue;
      url = u.href;
    } catch {
      continue;
    }
    const location = [firstText(raw.city), firstText(raw.country)].filter(Boolean).join(', ');
    rows.push({ id: url, title, url, location, postedAt: toEpochMs(raw.jobposteddate) });
  }
  return { rows, rawCount: json.results.length, total };
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

/** @type {Provider} */
export default {
  id: 'slb',

  detect(entry) {
    try {
      const raw = entry?.careers_url || entry?.api;
      if (typeof raw !== 'string') return null;
      const u = new URL(raw);
      if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname.toLowerCase())) return null;
      return { url: u.href };
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry); // throws before any request on a bad host
    const html = await fetchTextWithRetry(ctx, `${SITE_ORIGIN}${PAGE_PATH}`, {
      redirect: 'error',
      timeoutMs: TIMEOUT_MS,
      headers: { accept: 'text/html' },
    });
    const settings = extractCoveoSettings(html);

    const ctxMaxPages = Number(ctx?.maxPages);
    const probing = ctxMaxPages > 0;
    const maxPages = resolveMaxPages(entry);
    // The settings page counts as one request; the probe budget is 4.
    const pagesToFetch = Math.min(maxPages, probing ? ctxMaxPages : Infinity);

    const jobs = [];
    const seen = new Set();
    let total = null;
    let stopReason = 'end';
    for (let page = 0; page < pagesToFetch; page++) {
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const req = buildSearchRequest(settings, cfg, page * PAGE_SIZE);
      let json;
      try {
        json = await fetchJsonWithRetry(ctx, req.url, {
          method: 'POST',
          redirect: 'error',
          timeoutMs: TIMEOUT_MS,
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: `Bearer ${settings.accessToken}`,
          },
          body: JSON.stringify(req.body),
        });
      } catch (err) {
        if (probing || page === 0) throw err; // unwrapped: probe budget identity must survive
        console.error(`⚠️  slb: ${entry.name} page ${page + 1} failed (${err?.message}) — keeping ${jobs.length} postings`);
        stopReason = 'error';
        break;
      }
      const parsed = parseSearchResponse(json);
      if (total === null && parsed.total !== null) total = parsed.total;
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
      if (parsed.rawCount < PAGE_SIZE || fresh === 0) break;
      if (total !== null && (page + 1) * PAGE_SIZE >= total) break;
      if (page === pagesToFetch - 1) stopReason = probing ? 'probe' : 'max_pages';
    }
    if (stopReason === 'max_pages' && total !== null && jobs.length < total) {
      console.error(`⚠️  slb: ${entry.name} truncated at ${jobs.length} of ${total} postings — raise max_pages on this entry for more`);
    }
    return jobs;
  },
};
