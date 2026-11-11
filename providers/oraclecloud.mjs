// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Oracle Recruiting Cloud (ORC) / Fusion Candidate Experience provider — hits
// the public recruitingCEJobRequisitions REST API (zero-auth, GET). Large
// employers (JPMorgan Chase, Oracle, BNY Mellon, American Express, Honeywell, …)
// run their careers site on ORC.
//
// Host patterns (per-tenant, dynamic):
//   <tenant>.fa.oraclecloud.com
//   <tenant>.fa.<region>.oraclecloud.com   (e.g. us2)
//   <tenant>.fa.ocs.oraclecloud.com
//   ...and the same three shapes on the numbered apex `oraclecloud<NN>.com`
//   that Oracle issues to newer tenants (observed live: a Fusion board on
//   `<tenant>.fa.ocs.oraclecloud26.com` whose unnumbered `oraclecloud.com`
//   sibling host does not resolve at all).
//
// The numeric suffix is BOUNDED (1-99), not open-ended: this regex exists to
// PIN the host before every fetch, so it enumerates a finite apex family and
// never degrades into `oraclecloud<anything>.com`.
//
// Career page URL:
//   https://<host>/hcmUI/CandidateExperience/<lang>/sites/<siteNumber>/jobs
//   siteNumber is the segment after `sites/` (usually CX_1, CX_1002, …; default CX_1).
//
// JSON API (GET, zero-auth, no token/cookie):
//   https://<host>/hcmRestApi/resources/latest/recruitingCEJobRequisitions
//   ?onlyData=true
//   &expand=requisitionList.workLocation,requisitionList.secondaryLocations
//   &finder=findReqs;siteNumber=<site>,facetsList=...,limit=<n>,sortBy=POSTING_DATES_DESC,offset=<n>
//   &limit=<n>&offset=<n>   (set in BOTH finder and top-level — some tenants only honor one)
//   Optional keyword search: `keyword=%22<term>%22` INSIDE the finder only. A
//   top-level `&keyword=` is rejected with HTTP 400 ("Query parameter keyword
//   cannot be used in this context") — verified live 2026-11-09 on Kroger,
//   Marriott, Dollar General, AutoZone, Hormel and Ipsos. The site's search
//   matches title AND description (e.g. every Marriott posting mentions
//   "Marriott International", so `intern` barely narrows that board).
//   Optional: locationId=<numericId> (some tenants, e.g. BNY/Amex, need it to scope results).
//   The `expand` is REQUIRED: without it the API returns TotalJobsCount but an
//   empty/absent requisitionList (verified live against JPMC).
//   Response: items[0].requisitionList[] (jobs), items[0].TotalJobsCount (total),
//   top-level hasMore. Per item: Id, Title, PostedDate, PrimaryLocation,
//   WorkplaceTypeCode, ShortDescriptionStr, and (sometimes) ExternalURL.
//
// Known limitation: some tenants front the API with a WAF (e.g. Imperva) that
// 403s datacenter/cloud egress IPs. That's an environment/IP issue, not a
// provider bug — the same request succeeds from a residential IP. A browser-like
// User-Agent is sent to reduce (not eliminate) WAF friction.

import { decodeEntities } from './_html-entities.mjs';
import { BROWSER_LIKE_USER_AGENT, fetchJsonWithRetry } from './_http.mjs';

// `oraclecloud(?:[1-9][0-9]?)?` = oraclecloud.com plus oraclecloud1.com …
// oraclecloud99.com. No leading zero, at most two digits — a bounded family,
// so this stays a host pin and never becomes a wildcard apex match.
const ORACLE_HOST_RE = /^[a-z0-9-]+\.fa\.(?:[a-z0-9-]+\.)?(?:ocs\.)?oraclecloud(?:[1-9][0-9]?)?\.com$/i;

// Company-owned hosts that serve the same Candidate Experience site and REST
// API with no oraclecloud.com host behind a public name (Dell fronts it with
// its own domain). An explicit list, never a pattern.
const VANITY_HOSTS = new Set(['enterpriseplatform.dell.com']);

const PAGE_SIZE = 200;
const MAX_PAGES = 25;             // default safety cap (~5000 jobs); entry `max_pages` overrides
const RETRY_POLICY = { retries: 3 };
const INTER_PAGE_DELAY_MS = 250;  // WAF-aware spacing between same-host pages

// facetsList is a fixed constant on the finder; %3B is the encoded ';' separator.
const FACETS_LIST = 'LOCATIONS%3BWORK_LOCATIONS%3BWORKPLACE_TYPES%3BTITLES%3BCATEGORIES%3BORGANIZATIONS%3BPOSTING_DATES%3BFLEX_FIELDS';

/** @param {string} url */
function assertOracleUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`oraclecloud: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`oraclecloud: URL must use HTTPS: ${url}`);
  if (!ORACLE_HOST_RE.test(parsed.hostname) && !VANITY_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`oraclecloud: untrusted hostname "${parsed.hostname}" — must match *.fa[.<region>][.ocs].oraclecloud[1-99].com`);
  }
  return url;
}

// NaN-safe Date.parse — `|| undefined` would also coerce a valid epoch 0.
// (copied from greenhouse.mjs)
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function sleep(ms, ctx) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve ORC coordinates from a portal entry. `entry.api` takes precedence
 * over `entry.careers_url` (mirrors greenhouse/ashby/smartrecruiters) so a
 * branded careers page can stay as careers_url while the ORC host/site is
 * pinned via api:. Honors optional `entry.siteNumber` / `entry.locationId`.
 *
 * @param {import('./_types.js').PortalEntry & {siteNumber?:string, locationId?:string|number}} entry
 * @returns {{host:string, lang:string, siteNumber:string, locationId:(string|null)}|null}
 */
export function resolveSite(entry) {
  for (const raw of [entry.api, entry.careers_url]) {
    if (typeof raw !== 'string' || !raw) continue;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:') continue;
    if (!ORACLE_HOST_RE.test(parsed.hostname) && !VANITY_HOSTS.has(parsed.hostname.toLowerCase())) continue;

    const segs = parsed.pathname.split('/').filter(Boolean);
    // Path shape: /hcmUI/CandidateExperience/<lang>/sites/<siteNumber>/...
    const ceIdx = segs.findIndex((s) => s === 'CandidateExperience');
    const lang = ceIdx !== -1 && segs[ceIdx + 1] ? segs[ceIdx + 1] : 'en';
    const sitesIdx = segs.indexOf('sites');
    const siteFromUrl = sitesIdx !== -1 && segs[sitesIdx + 1] ? segs[sitesIdx + 1] : null;

    const overrideSite = typeof entry.siteNumber === 'string' && entry.siteNumber ? entry.siteNumber : null;
    const siteNumber = overrideSite || siteFromUrl || 'CX_1';
    const locationId = entry.locationId != null && `${entry.locationId}` !== ''
      ? `${entry.locationId}`
      : null;

    return { host: parsed.hostname, lang, siteNumber, locationId };
  }
  return null;
}

/**
 * Build the requisitions API URL. Params are set in BOTH the finder segment
 * and top-level (some tenants only honor one). facetsList uses %3B-encoded ';'.
 *
 * @param {{host:string, siteNumber:string, locationId?:(string|null)}} site
 * @param {number} offset
 * @param {number} limit
 * @param {string|null|{keyword?:string|null, filter?:string|null, facetValues?:boolean}} [query]
 *   a search term (finder `keyword=`), or an object: `keyword`; `filter`, a
 *   ready finder pair such as `selectedCategoriesFacet=123` (see facetFilters);
 *   `facetValues: true` adds `flexFieldsFacet.values` to expand (flex-field
 *   facet values are absent from the response without it).
 */
export function buildApiUrl(site, offset = 0, limit = PAGE_SIZE, query = null) {
  const q = typeof query === 'string' || query == null ? { keyword: query } : query;
  const keyword = q.keyword;
  // Finder grammar: `findReqs;key=val,key=val,...` — a ';' after the finder
  // name, then comma-separated key/value pairs. (A comma after findReqs 400s.)
  const finderParams = [
    `siteNumber=${site.siteNumber}`,
    `facetsList=${FACETS_LIST}`,
    `limit=${limit}`,
    'sortBy=POSTING_DATES_DESC',
    `offset=${offset}`,
  ];
  if (site.locationId) finderParams.push(`locationId=${site.locationId}`);
  // Keyword lives in the finder only (top-level `keyword` 400s). Quoted and
  // percent-encoded so a ',' or ';' in a term cannot break the finder grammar.
  if (typeof keyword === 'string' && keyword.trim()) {
    finderParams.push(`keyword=%22${encodeURIComponent(keyword.trim().replace(/"/g, ''))}%22`);
  }
  if (typeof q.filter === 'string' && q.filter) finderParams.push(q.filter);
  const finder = `findReqs;${finderParams.join(',')}`;
  const expand = 'requisitionList.workLocation,requisitionList.secondaryLocations'
    + (q.facetValues ? ',flexFieldsFacet.values' : '');
  return `https://${site.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`
    + `?onlyData=true`
    + `&expand=${encodeURIComponent(expand)}`
    + `&finder=${finder}`
    + `&limit=${limit}&offset=${offset}`;
}

/**
 * Build the public posting URL for a requisition Id.
 * @param {{host:string, lang:string, siteNumber:string}} site
 * @param {string} id
 */
export function buildJobUrl(site, id) {
  return `https://${site.host}/hcmUI/CandidateExperience/${site.lang}/sites/${site.siteNumber}/job/${id}`;
}

/**
 * Assemble a location string for a requisition. Prefers PrimaryLocation; else
 * builds from the expanded workLocation object; appends a remote/hybrid hint
 * from WorkplaceTypeCode. Returns "" when nothing is available.
 * @param {any} req
 */
function assembleLocation(req) {
  let base = typeof req.PrimaryLocation === 'string' ? req.PrimaryLocation.trim() : '';
  if (!base && Array.isArray(req.workLocation) && req.workLocation.length) {
    const wl = req.workLocation[0] || {};
    base = [wl.TownOrCity, wl.Region, wl.Country].filter((v) => typeof v === 'string' && v.trim()).join(', ');
  }
  const wt = req.WorkplaceTypeCode;
  const remoteHint = wt === 'ORA_REMOTE' ? 'Remote' : wt === 'ORA_HYBRID' ? 'Hybrid' : '';
  return [base, remoteHint].filter(Boolean).join(' · ');
}

/**
 * Pure normalizer for an ORC requisitions response. Exported for unit tests.
 * Reads items[0].requisitionList[], maps each to the Job shape, drops rows with
 * no resolvable URL. Returns [] for null / {} / non-array / {items:null}.
 *
 * @param {any} json
 * @param {{host:string, lang:string, siteNumber:string}} site
 * @param {string} companyName
 * @returns {Array<{title:string, url:string, company:string, location:string, description?:string, postedAt?:number}>}
 */
export function parseOracleResponse(json, site, companyName) {
  const item = Array.isArray(json?.items) ? json.items[0] : null;
  const list = item && Array.isArray(item.requisitionList) ? item.requisitionList : null;
  if (!list) return [];
  const out = [];
  for (const req of list) {
    if (!req || typeof req !== 'object') continue;
    const id = req.Id != null ? String(req.Id) : (req.RequisitionNumber != null ? String(req.RequisitionNumber) : '');
    const externalUrl = typeof req.ExternalURL === 'string' && req.ExternalURL.trim() ? req.ExternalURL.trim() : '';
    const url = externalUrl || (id ? buildJobUrl(site, id) : '');
    if (!url) continue; // dedup key — drop rows we can't link to
    const job = {
      title: typeof req.Title === 'string' ? req.Title : '',
      url,
      company: companyName,
      location: assembleLocation(req),
    };
    if (typeof req.ShortDescriptionStr === 'string' && req.ShortDescriptionStr.trim()) {
      job.description = decodeEntities(req.ShortDescriptionStr);
    }
    const postedAt = toEpochMs(req.PostedDate);
    if (postedAt !== undefined) job.postedAt = postedAt;
    out.push(job);
  }
  return out;
}

/**
 * Normalize `entry.keywords` into a de-duplicated list of non-empty terms.
 * Absent / empty / false → [] (keyword search off).
 * @param {any} raw
 * @returns {string[]}
 */
export function normalizeKeywords(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const term = t.trim();
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    out.push(term);
  }
  return out;
}

// Facet values that mean a student / early-career / contract / master's-level
// role (user decision 2026-11-09). Plain words — `entry.facet_values` (array
// of words/phrases) replaces this list; configuration is never a regex.
const DEFAULT_FACET_WORDS = ['intern', 'internship', 'co-op', 'coop', 'student', 'contract', 'master',
  'graduate', 'early career', 'early talent', 'campus', 'university', 'apprentice'];
const FACET_VALUE_MAX_LEN = 200;
// Words that contain a list word but never mean a student role: "Marriott
// International, Inc." (organization) and "Marriott International HQ" (work
// location) were seen live; "Internal Audit" is the other obvious one. They
// are blanked before matching, unconditionally, whatever the word list is.
const FACET_EXCLUDE_RE = /\bintern(?:al|ational)\w*/gi;
const STUDENT_FACET_RE = facetMatcher(DEFAULT_FACET_WORDS);

// Facets that describe the job itself (not where/when it is). Location,
// work-location, posting-date and workplace-type facets are never used.
const JOB_FACETS = [
  { key: 'categoriesFacet', param: 'selectedCategoriesFacet', name: 'categories' },
  { key: 'titlesFacet', param: 'selectedTitlesFacet', name: 'titles' },
  { key: 'organizationsFacet', param: 'selectedOrganizationsFacet', name: 'organizations' },
];

// Shared facet-selection rule (all providers, 2026-11-09). A facet whose name
// or label looks like a place, a store, a title list, a brand or a department
// code is never used, nor one with more than FACET_MAX_VALUES values.
// Preferred facets look like a job/employment type, category, level or
// function; among the eligible ones the facet with the FEWEST matching jobs
// (> 0) wins, and only that one facet is queried (never a cross-facet merge).
const FACET_NAME_EXCLUDE_RE = /\b(?:locations?|cit(?:y|ies)|states?|countr(?:y|ies)|regions?|zip|postal|stores?|sites?|titles?|job titles?|brands?|department codes?)\b/i;
const FACET_NAME_PREFER_RE = /\b(?:employment[\s_-]*types?|job[\s_-]*types?|worker[\s_-]*types?|posting[\s_-]*types?|categor(?:y|ies)|experience[\s_-]*levels?|career[\s_-]*levels?|job[\s_-]*functions?|time[\s_-]*types?|job[\s_-]*famil(?:y|ies)(?:[\s_-]*groups?)?|tags?)\b/i;
const FACET_MAX_VALUES = 200;

/**
 * Every eligible facet of an unfiltered response (items[0]) that has
 * student-looking values, one candidate per facet with ALL its matching
 * values OR'd into one finder pair: `selectedXFacet=id1%3Bid2` for the
 * built-in facets, `selectedFlexFieldsFacets="<field>|v1;v2"` for a flex
 * field (both verified live 2026-11-09 on Kroger: 54 + 67 = 121).
 *
 * @param {any} item
 * @param {RegExp} [matcher]  value matcher from facetMatcher(); default list
 * @returns {Array<{name:string, label:string, values:string[], filter:string, count:number, preferred:boolean}>}
 */
export function facetFilters(item, matcher = STUDENT_FACET_RE) {
  if (!item || typeof item !== 'object') return [];
  // Values are truncated to 200 chars; internal/international words are
  // blanked first so a value matching only through them never counts.
  const isStudent = (name) => matcher.test(name.slice(0, FACET_VALUE_MAX_LEN).replace(FACET_EXCLUDE_RE, ' '));
  const safe = (v) => typeof v === 'string' || typeof v === 'number';
  const sum = (hits) => hits.reduce((n, v) => n + (typeof v.TotalCount === 'number' ? v.TotalCount : 0), 0);
  const eligible = (name, label, list) => list.length <= FACET_MAX_VALUES
    && !FACET_NAME_EXCLUDE_RE.test(name) && !(label && FACET_NAME_EXCLUDE_RE.test(label));
  const preferred = (name, label) => FACET_NAME_PREFER_RE.test(name) || Boolean(label && FACET_NAME_PREFER_RE.test(label));
  const out = [];
  for (const f of JOB_FACETS) {
    const list = Array.isArray(item[f.key]) ? item[f.key] : [];
    if (!eligible(f.name, '', list)) continue;
    const hits = list.filter((v) => v && safe(v.Id) && typeof v.Name === 'string'
      && isStudent(v.Name) && !/[,;"|]/.test(String(v.Id)) && v.TotalCount !== 0);
    if (!hits.length) continue;
    out.push({
      name: f.name,
      label: '',
      values: hits.map((v) => v.Name),
      filter: `${f.param}=${hits.map((v) => encodeURIComponent(String(v.Id))).join('%3B')}`,
      count: sum(hits),
      preferred: preferred(f.name, ''),
    });
  }
  const flex = Array.isArray(item.flexFieldsFacet) ? item.flexFieldsFacet : [];
  for (const field of flex) {
    if (!field || typeof field.Name !== 'string' || !Array.isArray(field.values)) continue;
    const label = typeof field.Label === 'string' ? field.Label : '';
    if (!eligible(field.Name, label, field.values)) continue;
    const hits = field.values.filter((v) => v && safe(v.Id) && typeof v.Name === 'string'
      && isStudent(v.Name) && !/[;"|]/.test(String(v.Id)) && v.TotalCount !== 0);
    if (!hits.length) continue;
    const pair = `${field.Name}|${hits.map((v) => String(v.Id)).join(';')}`;
    out.push({
      name: `flex:${field.Name}${label ? ` (${label})` : ''}`,
      label,
      values: hits.map((v) => v.Name),
      filter: `selectedFlexFieldsFacets=%22${encodeURIComponent(pair)}%22`,
      count: sum(hits),
      preferred: preferred(field.Name, label),
    });
  }
  return out;
}

/**
 * Pick the ONE facet to query: preferred facets first; among them (or among
 * all eligible ones when none is preferred) the fewest matching jobs > 0.
 * A candidate whose counts are all missing (0) is skipped. Ties keep order.
 * @param {ReturnType<typeof facetFilters>} candidates
 */
export function chooseFacet(candidates) {
  const usable = candidates.filter((c) => c.count > 0);
  const pool = usable.some((c) => c.preferred) ? usable.filter((c) => c.preferred) : usable;
  let best = null;
  for (const c of pool) if (!best || c.count < best.count) best = c;
  return best;
}

/**
 * Build the facet value matcher from a list of plain words/phrases
 * (`entry.facet_values`): each word is regex-escaped, matched whole-word,
 * case-insensitively, with an optional plural / possessive suffix
 * (s, es, 's, ’s). Inner whitespace or '-' in a phrase matches any run of
 * spaces/hyphens ("co-op" also matches "Co op"). Absent, empty or not an
 * array → the built-in default list. No regular expression is ever taken
 * from configuration.
 * @param {any} raw
 * @returns {RegExp}
 */
export function facetMatcher(raw) {
  const words = Array.isArray(raw)
    ? raw.filter((w) => typeof w === 'string' && w.trim()).map((w) => w.trim())
    : [];
  const list = words.length ? words : DEFAULT_FACET_WORDS;
  const escaped = list.map((w) => w
    .split(/[\s-]+/).filter(Boolean)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'))
    .join('[\\s-]+'));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join('|')})(?:e?s|['’]s)?(?![\\p{L}\\p{N}])`, 'iu');
}

/**
 * Walk the requisitions API by offset for one query (keyword or none).
 * `firstJson`, when given, is an already-fetched page 0 for the same query.
 * Returns the parsed jobs, the reported TotalJobsCount (or null) and whether
 * the walk stopped on the page cap with rows still remaining.
 */
async function walkPages(entry, ctx, site, maxPages, query, firstJson) {
  const all = [];
  let total = null;
  let capped = false;
  for (let page = 0; page < maxPages; page++) {
    const offset = page * PAGE_SIZE;
    let json;
    if (page === 0 && firstJson !== undefined) {
      json = firstJson;
    } else {
      json = await fetchPage(ctx, site, offset, query, page > 0);
    }

    const parsed = parseOracleResponse(json, site, entry.name);
    all.push(...parsed);

    const item = Array.isArray(json?.items) ? json.items[0] : null;
    if (total === null && item && typeof item.TotalJobsCount === 'number') total = item.TotalJobsCount;
    const listLen = item && Array.isArray(item.requisitionList) ? item.requisitionList.length : 0;

    // Stop conditions. NOTE: `hasMore` is unreliable on some tenants (e.g.
    // JPMC returns hasMore:false on EVERY page even with 7000+ jobs), so it's
    // NOT used to stop — trusting it caps the scan at one page. The
    // authoritative signals are the returned list length and TotalJobsCount:
    //   - an empty or short page means we've reached the end;
    //   - once we've paged past TotalJobsCount there's nothing left to fetch.
    // The API also returns an EMPTY page at offset >= 10000 however large
    // TotalJobsCount is (verified live: Kroger 11,822 → offset 10000 = 0 rows),
    // so an empty page short of the reported total is a server-side cap.
    if (listLen === 0 && total !== null && offset < total) capped = true;
    if (listLen === 0 || listLen < PAGE_SIZE) break;
    if (total !== null && offset + PAGE_SIZE >= total) break;
    if (page === maxPages - 1) capped = true;
  }
  return { jobs: all, total, capped };
}

async function fetchPage(ctx, site, offset, query, delay) {
  const apiUrl = buildApiUrl(site, offset, PAGE_SIZE, query);
  assertOracleUrl(apiUrl); // SSRF guard before every fetch
  if (delay) await sleep(INTER_PAGE_DELAY_MS, ctx);
  return fetchJsonWithRetry(ctx, apiUrl, {
    redirect: 'error',
    headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT, Accept: 'application/json' },
  }, RETRY_POLICY);
}

/** @type {Provider} */
export default {
  id: 'oraclecloud',

  detect(entry) {
    try {
      const site = resolveSite(entry);
      return site ? { url: buildApiUrl(site, 0, PAGE_SIZE) } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const site = resolveSite(entry);
    if (!site) throw new Error(`oraclecloud: cannot derive API URL for ${entry.name}`);

    // A positive integer `max_pages` on the entry replaces the default cap, up or down,
    // so a board larger than MAX_PAGES x PAGE_SIZE can be read whole.
    // A health probe passes ctx.maxPages; it bounds every walk (probes stay small).
    const probePages = Number(ctx?.maxPages);
    const probing = Number.isInteger(probePages) && probePages > 0;
    const entryPages = Number.isInteger(entry.max_pages) && entry.max_pages > 0
      ? entry.max_pages
      : MAX_PAGES;
    const maxPages = probing ? Math.min(entryPages, probePages) : entryPages;

    const terms = normalizeKeywords(entry.keywords);
    if (terms.length === 0) {
      return (await walkPages(entry, ctx, site, maxPages, null)).jobs;
    }
    // A health probe (ctx.maxPages) never searches: unfiltered pages only, up
    // to the probe's page budget, no facet/keyword requests, no marker.
    if (probing) {
      return (await walkPages(entry, ctx, site, maxPages, null)).jobs;
    }

    // Student search (entry.keywords + optional entry.keyword_min_total).
    // Page 0 is read unfiltered first — for the board total (a board at or
    // under the threshold is still read whole, reusing page 0) and for the
    // site's own facet lists. A student facet (category / job family /
    // organization / flex field) beats keyword search; keywords are the
    // fallback when no such facet exists or it returns nothing.
    // `entry.facet: false` skips the facet attempt.
    const minTotal = Number.isInteger(entry.keyword_min_total) && entry.keyword_min_total > 0
      ? entry.keyword_min_total
      : null;
    const facetOn = entry.facet !== false;
    let boardTotal = null;
    let first;
    if (minTotal !== null || facetOn) {
      first = await fetchPage(ctx, site, 0, facetOn ? { facetValues: true } : null, false);
      const item = Array.isArray(first?.items) ? first.items[0] : null;
      if (item && typeof item.TotalJobsCount === 'number') boardTotal = item.TotalJobsCount;
      if (minTotal !== null && boardTotal !== null && boardTotal <= minTotal) {
        return (await walkPages(entry, ctx, site, maxPages, null, first)).jobs;
      }
    }

    const merge = (into, seen, list) => {
      for (const job of list) {
        if (seen.has(job.url)) continue; // url is built from the requisition Id
        seen.add(job.url);
        into.push(job);
      }
    };

    if (facetOn) {
      const facet = chooseFacet(facetFilters(Array.isArray(first?.items) ? first.items[0] : null, facetMatcher(entry.facet_values)));
      if (facet) {
        await sleep(INTER_PAGE_DELAY_MS, ctx);
        const res = await walkPages(entry, ctx, site, maxPages, { filter: facet.filter });
        if (res.jobs.length) {
          const fjobs = [];
          merge(fjobs, new Set(), res.jobs);
          fjobs.keywordSearch = {
            mode: 'facet',
            terms: 0,
            boardTotal,
            perTerm: {},
            facet: { name: facet.name, values: facet.values },
          };
          if (res.capped) fjobs.truncated = true;
          return fjobs;
        }
      }
    }

    const jobs = [];
    const seen = new Set();
    const perTerm = {};
    let truncated = false;
    let requested = first !== undefined; // page 0 already fetched → space the next request
    for (const term of terms) {
      if (requested) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const res = await walkPages(entry, ctx, site, maxPages, term);
      requested = true;
      perTerm[term] = res.jobs.length;
      if (res.capped) truncated = true;
      merge(jobs, seen, res.jobs);
    }
    jobs.keywordSearch = { mode: 'keywords', terms: terms.length, boardTotal, perTerm };
    if (truncated) jobs.truncated = true;
    return jobs;
  },
};
