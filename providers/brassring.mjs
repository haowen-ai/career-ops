// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchJsonWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

// IBM / Infinite Kenexa BrassRing "TGnewUI" career sites (→ tracked_companies:).
//
// One generic provider for every BrassRing tenant. A tenant is a pair
// (partnerid, siteid) taken from the careers_url query string, e.g.
//   https://sjobs.brassring.com/TGnewUI/Search/Home/Home?partnerid=26350&siteid=6930
//
// The search page is an AngularJS shell; its own scripts (verified live
// 2026-11-07 by reading the page and its bundles, then replaying the calls):
//
//   1. GET  {origin}/TGnewUI/Search/Home/Home?partnerid=P&siteid=S
//      → HTML with <input name="__RequestVerificationToken" value="…"> plus
//        Set-Cookie tg_rft_mvc / tg_session… (an anti-forgery pair: the
//        Ajax calls answer HTTP 500 without BOTH the cookie and the token in
//        an `RFT` header). The page also embeds the tenant's display config
//        in <input id="searchResults" value="{…JobFieldsToDisplay,
//        LocationCustomSolrFields…}"> — we read it to know which fields
//        carry the location (they differ per tenant: formtext5, formtext23,
//        location, …).
//   2. POST {origin}/TgNewUI/Search/Ajax/MatchedJobs   (page 1, with Facets)
//      {PartnerId,SiteId,Keyword:"",Location:"",FacetFilterFields:{Facet:[]},
//       PowerSearchOptions:{PowerSearchOption:[]},SortType:"JobTitle",…}
//      → {"JobsCount":1390,"Jobs":{"Job":[{"Questions":[{"QuestionName":
//        "reqid","Value":"1440057"},{"QuestionName":"jobtitle",…},
//        {"QuestionName":"lastupdated","Value":"07-Nov-2026"},…],
//        "Link":"https://sjobs.brassring.com/TGnewUI/Search/home/
//        HomeWithPreLoad?partnerid=…&siteid=…&PageType=JobDetails&jobid=…"}]},
//        "Facets":{"Facet":[{"Name":"formtext6","Description":"Division",…}]}}
//   3. POST {origin}/TgNewUI/Search/Ajax/ProcessSortAndShowMoreJobs
//      {partnerId,siteId,…,SortType:"JobTitle",pageNumber:N}  (pages 2..)
//      Page size is fixed at 50 by the site.
//
// Sort: the default (relevance) and "LastUpdated" orders are unstable across
// pages (ties reshuffle — 20 of 150 rows repeated in a live walk); "JobTitle"
// gave 1389 unique of 1390 over a full 28-page walk, so we sort by title and
// dedupe by reqid.
//
// No server-side country filter exists across tenants (country, when it is a
// facet at all, lives in a tenant-specific formtextNN field). Tenants that run
// a dedicated US site (e.g. a separate US siteid) should point careers_url at
// that site. `location_fields: [formtext5, …]` on the entry overrides the
// auto-detected location fields.
//
// Hosts are pinned: careers_url must be https on a known BrassRing host, and
// every request goes to that same origin with redirect:'error'.

const ALLOWED_HOSTS = new Set([
  'sjobs.brassring.com',
  'krb-sjobs.brassring.com',
  'jobs.ubs.com', // UBS's vanity CNAME for the same TGnewUI app (partnerid 25008)
]);
const PAGE_SIZE = 50; // fixed by the site
const DEFAULT_MAX_PAGES = 40; // 2,000 rows; the largest target seen (PFG) is 1,390
const MAX_PAGES_CAP = 200;
const INTER_PAGE_DELAY_MS = 250;
const TIMEOUT_MS = 30_000; // home page ~1.4 MB, a 50-row page ~0.75 MB (descriptions ride along)
const SORT_TYPE = 'JobTitle';

const NON_LOCATION_FIELDS = new Set(['reqid', 'autoreq', 'jobtitle', 'department', 'lastupdated', 'jobdescription', 'hotjob', 'clientid', 'siteid', 'gqid']);
const LOCATION_DESC_RE = /locat|city|town|state|province|region|country|county|district|ville|stadt|ort\b|land\b/i;
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** case-insensitive query param @param {URLSearchParams} p @param {string} name */
function qp(p, name) {
  for (const [k, v] of p) if (k.toLowerCase() === name) return v;
  return null;
}

/**
 * Validate careers_url and extract the tenant. Throws on malformed URL,
 * non-https, a host outside the allowlist, or missing/non-numeric ids.
 * @param {any} entry
 */
export function resolveConfig(entry) {
  const raw = entry?.careers_url || entry?.api;
  if (typeof raw !== 'string' || !raw) throw new Error('brassring: careers_url is required');
  const u = new URL(raw); // throws on malformed input
  if (u.protocol !== 'https:') throw new Error(`brassring: refusing non-https URL ${u.protocol}`);
  const host = u.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) throw new Error(`brassring: host not allowed: ${u.hostname}`);
  const partnerId = qp(u.searchParams, 'partnerid');
  const siteId = qp(u.searchParams, 'siteid');
  if (!partnerId || !/^\d{1,9}$/.test(partnerId)) throw new Error('brassring: careers_url needs a numeric partnerid');
  if (!siteId || !/^\d{1,9}$/.test(siteId)) throw new Error('brassring: careers_url needs a numeric siteid');
  const origin = `https://${host}`;
  return {
    host,
    origin,
    partnerId,
    siteId,
    homeUrl: `${origin}/TGnewUI/Search/Home/Home?partnerid=${partnerId}&siteid=${siteId}`,
    firstPageUrl: `${origin}/TgNewUI/Search/Ajax/MatchedJobs`,
    morePagesUrl: `${origin}/TgNewUI/Search/Ajax/ProcessSortAndShowMoreJobs`,
  };
}

/**
 * Build a Cookie header from Set-Cookie values (name=value only).
 * @param {unknown} setCookies @returns {string}
 */
export function cookieHeaderFrom(setCookies) {
  const out = [];
  for (const raw of Array.isArray(setCookies) ? setCookies : []) {
    if (typeof raw !== 'string') continue;
    const pair = raw.split(';')[0].trim();
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    if (/[\r\n]/.test(pair)) continue;
    out.push(pair);
  }
  return out.join('; ');
}

/**
 * Extract the anti-forgery token and tenant display config from the home page.
 * Throws when the token is missing (wrong partnerid/siteid, or not a TGnewUI page).
 * @param {unknown} html
 */
export function parseHomePage(html) {
  if (typeof html !== 'string' || !html) throw new Error('brassring: empty home page');
  const tok = html.match(/name="__RequestVerificationToken"[^>]*\svalue="([^"]+)"/) || html.match(/__RequestVerificationToken" type="hidden" value="([^"]+)"/);
  if (!tok) throw new Error('brassring: home page has no __RequestVerificationToken (bad partnerid/siteid, or the site changed)');
  /** @type {any} */
  let cfg = null;
  const sr = html.match(/<input[^>]*\sid="searchResults"[^>]*\svalue="([^"]*)"/);
  if (sr) {
    try {
      cfg = JSON.parse(decodeEntities(sr[1]));
    } catch {
      cfg = null; // config is only used to pick location fields; fall back to defaults
    }
  }
  return {
    token: tok[1],
    jobFields: cfg && typeof cfg.JobFieldsToDisplay === 'object' ? cfg.JobFieldsToDisplay : null,
    locationSolrFields: cfg && typeof cfg.LocationCustomSolrFields === 'string' ? cfg.LocationCustomSolrFields : '',
  };
}

/**
 * Decide which Question names hold the location.
 * @param {{jobFields:any, locationSolrFields:string}} home
 * @param {any} facets  Facets.Facet array from page 1 (may be null)
 * @param {any} override entry.location_fields
 * @returns {string[]}
 */
export function pickLocationFields(home, facets, override) {
  if (Array.isArray(override)) {
    const o = override.filter((x) => typeof x === 'string' && x).map((x) => x.toLowerCase());
    if (o.length) return o;
  }
  const exclude = new Set(NON_LOCATION_FIELDS);
  const jf = home?.jobFields;
  for (const k of ['Position1', 'JobTitle', 'Summary']) if (jf && typeof jf[k] === 'string') exclude.add(jf[k].toLowerCase());
  const facetDesc = new Map();
  if (Array.isArray(facets)) {
    for (const f of facets) {
      if (f && typeof f.Name === 'string' && typeof f.Description === 'string') facetDesc.set(f.Name.toLowerCase(), f.Description);
    }
  }
  const cand = [];
  const p3 = jf?.Position3;
  if (Array.isArray(p3)) cand.push(...p3);
  else if (typeof p3 === 'string') cand.push(p3);
  cand.push(...String(home?.locationSolrFields || '').split(','));
  cand.push('location');
  const out = [];
  for (const c of cand) {
    if (typeof c !== 'string') continue;
    const n = c.trim().toLowerCase();
    if (!n || exclude.has(n) || out.includes(n)) continue;
    if (facetDesc.has(n) && !LOCATION_DESC_RE.test(facetDesc.get(n))) continue;
    out.push(n);
  }
  return out;
}

/** "07-Nov-2026" (or ISO) → epoch ms UTC, NaN-safe. @param {unknown} v */
export function toEpochMs(v) {
  if (!v || typeof v !== 'string') return undefined;
  const m = v.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m) {
    const mon = MONTHS[/** @type {keyof typeof MONTHS} */ (m[2].toLowerCase())];
    if (mon === undefined) return undefined;
    return Date.UTC(Number(m[3]), mon, Number(m[1]));
  }
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms;
}

/** @param {unknown} s */
function clean(s) {
  return typeof s === 'string' ? decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
}

/**
 * Parse one MatchedJobs / ProcessSortAndShowMoreJobs response.
 * - an empty page only when JobsCount is exactly 0 and the Jobs container is
 *   absent, {Job:null} or {Job:[]}
 * - null / {} / missing JobsCount on an empty page / error envelope / unknown
 *   Jobs keys / non-array Jobs.Job → throw (never a silent empty board)
 * @param {any} json
 * @param {{origin:string, host:string, partnerId:string, siteId:string}} cfg
 * @param {string[]} locFields
 */
export function parseJobsResponse(json, cfg, locFields) {
  if (json == null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(`brassring: unexpected jobs response (${json === null ? 'null' : Array.isArray(json) ? 'array' : typeof json})`);
  }
  const keys = Object.keys(json);
  if (!('Jobs' in json) && !('JobsCount' in json)) {
    throw new Error(`brassring: unexpected jobs response shape (keys: ${keys.slice(0, 8).join(', ') || 'none'})`);
  }
  const total = Number.isInteger(json.JobsCount) && json.JobsCount >= 0 ? json.JobsCount : null;
  const jobsObj = json.Jobs && typeof json.Jobs === 'object' && !Array.isArray(json.Jobs) ? json.Jobs : null;
  let list;
  if (jobsObj && Array.isArray(jobsObj.Job)) {
    list = jobsObj.Job;
  } else if (json.Jobs == null || (jobsObj && jobsObj.Job == null && Object.keys(jobsObj).every((k) => k === 'Job'))) {
    if (total === null) throw new Error('brassring: jobs response has no Jobs.Job list and no JobsCount (cannot confirm zero jobs)');
    if (total > 0) throw new Error(`brassring: JobsCount=${total} but Jobs container is missing`);
    list = [];
  } else {
    const jk = jobsObj ? Object.keys(jobsObj).slice(0, 8).join(', ') || 'none' : typeof json.Jobs;
    throw new Error(`brassring: unexpected jobs response (Jobs.Job is not an array; Jobs: ${jk})`);
  }
  if (list.length === 0 && total !== 0) {
    throw new Error(`brassring: empty Jobs.Job list but JobsCount is ${total === null ? 'missing' : total} (cannot confirm zero jobs)`);
  }
  const facets = json.Facets && Array.isArray(json.Facets.Facet) ? json.Facets.Facet : null;

  const rows = [];
  for (const job of list) {
    if (!job || typeof job !== 'object' || !Array.isArray(job.Questions)) continue;
    /** @type {Record<string,string>} */
    const q = {};
    for (const it of job.Questions) {
      if (it && typeof it.QuestionName === 'string' && typeof it.Value === 'string') q[it.QuestionName.toLowerCase()] = it.Value;
    }
    const title = clean(q.jobtitle);
    const reqid = typeof q.reqid === 'string' && /^\d{1,12}$/.test(q.reqid.trim()) ? q.reqid.trim() : null;
    let url = null;
    if (typeof job.Link === 'string') {
      try {
        const u = new URL(job.Link);
        if (u.protocol === 'https:' && u.hostname.toLowerCase() === cfg.host) url = u.href;
      } catch {
        /* fall through */
      }
    }
    if (!url && reqid) {
      url = `${cfg.origin}/TGnewUI/Search/home/HomeWithPreLoad?partnerid=${cfg.partnerId}&siteid=${cfg.siteId}&PageType=JobDetails&jobid=${reqid}`;
    }
    if (!title || !url) continue;
    const locParts = [];
    for (const f of locFields) {
      const v = clean(q[f]);
      if (v && !locParts.includes(v)) locParts.push(v);
    }
    rows.push({ id: reqid || url, title, url, location: locParts.join(', '), postedAt: toEpochMs(q.lastupdated) });
  }
  return { rows, rawCount: list.length, total, facets };
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

/** @type {Provider} */
export default {
  id: 'brassring',

  detect(entry) {
    try {
      const raw = entry?.careers_url || entry?.api;
      if (typeof raw !== 'string') return null;
      const u = new URL(raw);
      if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname.toLowerCase())) return null;
      if (!/\/tgnewui\//i.test(u.pathname)) return null;
      const pid = qp(u.searchParams, 'partnerid');
      const sid = qp(u.searchParams, 'siteid');
      if (!pid || !/^\d+$/.test(pid) || !sid || !/^\d+$/.test(sid)) return null;
      return { url: u.href };
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry); // throws before any request on a bad host / ids
    if (typeof ctx?.fetchResponse !== 'function') {
      throw new Error('brassring: ctx.fetchResponse is required (the search API needs the home page session cookie)');
    }

    // 1. session: token + cookies + tenant config
    const homeCtx = { ...ctx, fetchJson: ctx.fetchResponse };
    const res = await fetchJsonWithRetry(homeCtx, cfg.homeUrl, { redirect: 'error', timeoutMs: TIMEOUT_MS, headers: { accept: 'text/html' } });
    const setCookies = typeof res?.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const cookie = cookieHeaderFrom(setCookies);
    const home = parseHomePage(await res.text());
    const headers = { accept: 'application/json', 'content-type': 'application/json', RFT: home.token, ...(cookie ? { cookie } : {}) };
    const post = (url, body) => fetchJsonWithRetry(ctx, url, { method: 'POST', body: JSON.stringify(body), headers, redirect: 'error', timeoutMs: TIMEOUT_MS });

    const ctxMaxPages = Number(ctx?.maxPages);
    const probing = ctxMaxPages > 0;
    const pagesToFetch = Math.min(resolveMaxPages(entry), probing ? ctxMaxPages : Infinity);

    const jobs = [];
    const seen = new Set();
    let total = null;
    let locFields = null;
    let stopReason = 'end';
    for (let page = 1; page <= pagesToFetch; page++) {
      if (page > 1) await sleep(INTER_PAGE_DELAY_MS, ctx);
      let json;
      try {
        json = page === 1
          ? await post(cfg.firstPageUrl, {
              PartnerId: cfg.partnerId, SiteId: cfg.siteId, Keyword: '', Location: '',
              KeywordCustomSolrFields: '', LocationCustomSolrFields: '',
              FacetFilterFields: { Facet: [] }, PowerSearchOptions: { PowerSearchOption: [] },
              SortType: SORT_TYPE, Latitude: 0, Longitude: 0,
            })
          : await post(cfg.morePagesUrl, {
              partnerId: cfg.partnerId, siteId: cfg.siteId, keyword: '', location: '',
              keywordCustomSolrFields: '', locationCustomSolrFields: '',
              facetfilterfields: { Facet: [] }, powersearchoptions: { PowerSearchOption: [] },
              SortType: SORT_TYPE, pageNumber: page, Latitude: 0, Longitude: 0,
            });
      } catch (err) {
        if (probing || page === 1) throw err; // unwrapped: probe budget identity must survive
        console.error(`⚠️  brassring: ${entry.name} page ${page} failed (${err?.message}) — keeping ${jobs.length} postings`);
        stopReason = 'error';
        break;
      }
      if (locFields === null) {
        // page 1 carries Facets (descriptions tell location facets from others)
        const facets = json && typeof json === 'object' && json.Facets && Array.isArray(json.Facets.Facet) ? json.Facets.Facet : null;
        locFields = pickLocationFields(home, facets, entry?.location_fields);
      }
      const parsed = parseJobsResponse(json, cfg, locFields);
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
      if (total !== null && page * PAGE_SIZE >= total) break;
      if (page === pagesToFetch) stopReason = probing ? 'probe' : 'max_pages';
    }

    if (stopReason === 'max_pages' && total !== null && jobs.length < total) {
      console.error(`⚠️  brassring: ${entry.name} truncated at ${jobs.length} of ${total} postings — raise max_pages on this entry for more`);
    }
    return jobs;
  },
};
