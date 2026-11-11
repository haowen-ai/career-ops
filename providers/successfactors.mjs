// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
import { decodeEntities } from './_html-entities.mjs';

// SAP SuccessFactors provider — Recruiting Marketing (RMK, ex-jobs2web) career
// sites (Career Site Builder's branded job boards). These are the portals big
// German industrials run at their own domains (jobs.zf.com, jobs.schaeffler.com,
// jobs.hensoldt.net, jobs.sap.com, …) — all served by the same SF RMK backend.
//
// The RMK backend exposes a public, no-auth job-list fragment endpoint:
//   GET {origin}/tile-search-results/?startrow={N}
// It returns an HTML fragment (not JSON) of <li class="job-tile job-id-{id}">
// blocks, each carrying data-url (job path), the title link, and — when the
// tenant configures it — a rendered city field. We parse those out; the scanner
// contract only needs {title, url, company, location, postedAt}.
//
// Pagination: startrow is a plain row offset, and page size is tenant-specific
// (Schaeffler serves 100/page, most others 25). We never assume a page size —
// each loop advances startrow by the number of tiles actually returned, and a
// per-id dedup set guards against overlap or a server that ignores the offset.
//
// Detection: branded RMK hosts (jobs.zf.com) contain no "successfactors" string,
// so detect() only auto-claims literal *.successfactors.eu/.com and jobs2web
// URLs. The branded portals are wired up with an explicit `provider:
// successfactors` in portals.yml (which bypasses detect()); `api:` may override
// careers_url when the public careers_url isn't the RMK origin.
//
// RMK carries no posting date in the list fragment, so postedAt is always
// omitted (consumers treat an absent date as "unknown", never as stale).
//
// ── CSB (Career Site Builder) variant ────────────────────────────────────────
// Newer SF tenants run the Career Site Builder "unified" search (jobs2web's
// searchResultsUnify.js). Their /tile-search-results/ endpoint returns only a
// 16-byte empty <!DOCTYPE html> shell — the jobs are loaded client-side from a
// JSON API instead:
//   POST {origin}/services/recruiting/v1/jobs
//   Content-Type: application/json
//   {"keywords":"","locale":"de_DE","location":"","pageNumber":0,"sortBy":"recent"}
//   → {"jobSearchResult":[{"response":{id,unifiedStandardTitle,unifiedUrlTitle,
//        jobLocationShort:[…],unifiedStandardStart:"6/18/26",…}}], "totalJobs":N}
// 10 results/page; pageNumber is 0-based. The detail URL the site itself builds
// (from searchResultsUnify.js) is {origin}/job/{urlTitle}/{id}-{locale}.
//
// CRITICAL — locale gating: the API only returns a posting under a locale it was
// published in (each record carries `supportedLocales`). The same tenant reports
// wildly different totals per locale — MAN: de_DE=601 but en_US=8; TRATON: en_US
// only; Hexagon: en_GB only (de_DE/en_US both 0). A hardcoded locale would miss
// entire tenants, so we DISCOVER each tenant's advertised locales from the
// language switcher on {origin}/search/ (the `locale=xx_XX` links), query every
// one, and dedup by job id. CSB carries a real posting date, so postedAt is set.
//
// Strategy selection: `sfVariant: csb` on the portal entry forces CSB directly;
// otherwise the RMK tile path runs first and, only if it yields zero postings
// (the empty-shell signature), we fall back to CSB automatically.

const MAX_PAGES = 40; // safety cap on request count (RMK tile pagination)
const MAX_JOBS = 1000; // default cap on total postings per site (both strategies); entry `max_jobs` overrides

// CSB knobs.
const CSB_PAGE_SIZE = 10; // fixed by the /services/recruiting/v1/jobs API
const CSB_MAX_PAGES_PER_LOCALE = 100; // safety cap per locale (100*10 = 1000 postings)
const CSB_MAX_LOCALES = 16; // guard against a tenant advertising an absurd locale list
// Locales tried when /search/ discovery yields nothing (fetch failed / markup
// changed). de_DE + en_US cover the DACH targets this provider is aimed at.
const CSB_DEFAULT_LOCALES = ['de_DE', 'en_US'];
// Query order: the DACH-relevant, usually job-rich locales first, so a bounded
// probe (max_pages:1) hits real postings early and dedup keeps a sensible URL
// locale for jobs published in several languages.
const CSB_LOCALE_PRIORITY = ['de_DE', 'en_US', 'en_GB', 'en_EN'];

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
  // Preserve a brand/tenant path prefix when the configured URL carries one —
  // some holding companies run several acquired brands off one shared RMK
  // instance, disambiguated by a path segment instead of a separate domain
  // (e.g. careers.nemetschek.com/Bluebeam/ vs. .../Vectorworks/). Strip a
  // trailing known-endpoint segment — /search/ (the page tenants commonly
  // configure as careers_url), or one of the API paths this module itself
  // builds below (/tile-search-results/, /services/recruiting/v1/jobs), in
  // case an `api:` override points straight at one — plus any trailing
  // slash, so all of those collapse to the same brand-scoped base instead of
  // doubling the endpoint segment onto itself. Single-domain tenants (the
  // common case) have an empty pathname, so base === origin unchanged.
  let path = u.pathname
    .replace(/\/(?:search|tile-search-results|services\/recruiting\/v1\/jobs)\/?$/i, '')
    .replace(/\/+$/, '');
  // A tenant category page (/go/<Name>/<id>/, e.g. careers.underarmour.com/
  // go/Internships/9635400/) is the site's own job filter: its jobs come from
  // /tile-search-results/category/<id>/ (the apiEndpoint the page itself
  // passes to j2w.SearchResults.init). The brand prefix before /go/ is kept.
  let category = null;
  const catM = path.match(/^(.*)\/go\/([^/]+)\/(\d+)$/);
  if (catM) {
    path = catM[1];
    let name = catM[2];
    try {
      name = decodeURIComponent(name);
    } catch {
      // keep the raw slug
    }
    category = { id: catM[3], name: name.replace(/-+/g, ' ').trim(), page: `${u.origin}${u.pathname}` };
  }
  const base = u.origin + path;
  // A search filter on careers_url (e.g. careers.sap.com/search/?q=intern&
  // locationsearch=United+States) is carried into every tile request, so a
  // huge global board can be read as its filtered view. startrow is owned by
  // the pagination loop and dropped here. Empty when the URL has no query
  // (the common case), which leaves the request URLs byte-identical.
  const sp = new URLSearchParams(u.search);
  sp.delete('startrow');
  const searchQuery = sp.toString();
  return {
    origin: u.origin,
    base,
    searchQuery,
    keywords: sp.get('q') || '',
    location: sp.get('locationsearch') || '',
    tileApi: category ? `${base}/tile-search-results/category/${category.id}/` : `${base}/tile-search-results/`,
    category,
    // jobBase stays origin-only: RMK tile data-url paths for a brand-scoped
    // tenant already carry the brand segment (confirmed against Nemetschek's
    // /Bluebeam/tile-search-results/ output), so prefixing base here would
    // double it up.
    jobBase: u.origin,
    jobsApi: `${base}/services/recruiting/v1/jobs`,
    searchPage: `${base}/search/`,
  };
}

/** @param {string} s */
function clean(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// RMK job paths encode the city as the leading slug segment:
//   /job/{City-Words}-{Title-Words}-{reqCode}/{id}/
// When the tenant doesn't render a dedicated city field we recover the city by
// stripping the title (and trailing code) off the front slug. We anchor on the
// first two title words — a prefix the slug always reproduces verbatim, unlike
// the title's tail where punctuation like "(m/w/d)" gets mangled.
/** @param {string} dataUrl @param {string} title */
export function cityFromSlug(dataUrl, title) {
  let path;
  try {
    path = decodeURIComponent(dataUrl);
  } catch {
    path = dataUrl;
  }
  const m = path.match(/\/job\/([^/]+)\//);
  if (!m) return '';
  const slug = m[1].toLowerCase();
  const words = title.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!words || !words.length) return '';
  // Anchor on the first two title words, but allow ANY run of non-alphanumerics
  // between them — in the slug those words may be joined by "-", "-amp-" (a
  // decoded "&"), or several hyphens, none of which survive the title's word
  // split. A rigid "word-word" anchor would miss "Program & Release" → "program-&amp;-release".
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let anchorRe;
  try {
    anchorRe = new RegExp(words.slice(0, 2).map(esc).join('[^\\p{L}\\p{N}]+'), 'u');
  } catch {
    return '';
  }
  const hit = slug.match(anchorRe);
  if (!hit || hit.index === undefined || hit.index <= 0) return '';
  return slug
    .slice(0, hit.index)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Parse one page fragment into raw {id, title, url, city} records.
// Each posting renders three responsive copies (desktop/tablet/mobile) inside
// one <li>; a single <li> per id means the top-level dedup already collapses
// them, and within a block the first match of each field wins.
/** @param {string} htmlText @param {string} jobBase */
export function parseTiles(htmlText, jobBase) {
  const out = [];
  const tileRe = /<li class="job-tile job-id-(\d+)\b[\s\S]*?<\/li>/g;
  let t;
  while ((t = tileRe.exec(htmlText)) !== null) {
    const id = t[1];
    const block = t[0];
    const urlM = block.match(/data-url="([^"]+)"/);
    if (!urlM) continue;
    const titleM = block.match(/class="jobTitle-link[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    const title = titleM ? clean(titleM[1]) : '';
    if (!title) continue;
    // data-url is an HTML attribute, so a literal "&" in the path arrives as
    // &amp;. Decode entities (but not percent-encoding — %28 etc. stays) before
    // both URL building and slug parsing, so the "amp" of &amp; can't leak into
    // the recovered city.
    const path = decodeEntities(urlM[1]);
    // Anchor on id="…-section-city-value"> — the value div. The sibling label
    // span references the same id via aria-describedby, so a looser match would
    // swallow the "City" label text too.
    const cityM = block.match(/id="[^"]*-section-city-value">([\s\S]*?)<\/div>/);
    const city = cityM ? clean(cityM[1]) : cityFromSlug(path, title);
    const url = /^https?:\/\//i.test(path) ? path : jobBase + (path.startsWith('/') ? path : '/' + path);
    out.push({ id, title, url, location: city });
  }
  return out;
}

// ── CSB helpers ──────────────────────────────────────────────────────────────

// Pull the tenant's advertised locales from the {origin}/search/ page. The CSB
// language switcher renders them as `/search/?q=&startrow=0&locale=xx_XX` links
// (HTML-escaped, so `&amp;` — the regex just anchors on `locale=`). Returns a
// de-duped, priority-ordered list; empty when the markup carries none.
/** @param {string} html */
export function extractLocales(html) {
  const found = new Set();
  const re = /locale=([a-z]{2}_[A-Z]{2})\b/g;
  let m;
  while ((m = re.exec(html)) !== null) found.add(m[1]);
  const all = [...found];
  const prio = (loc) => {
    const i = CSB_LOCALE_PRIORITY.indexOf(loc);
    return i === -1 ? CSB_LOCALE_PRIORITY.length : i;
  };
  all.sort((a, b) => prio(a) - prio(b) || a.localeCompare(b));
  return all.slice(0, CSB_MAX_LOCALES);
}

// CSB posting dates are rendered in the query locale's short format: US tenants
// send M/D/YY with slashes ("6/18/26"), European (de_DE) tenants send D.M.YY
// with dots ("20.11.23"). Infer the field order from the separator, treat a
// 2-digit year as 20YY, and return epoch ms. Anything unexpected yields
// undefined so a consumer sees "unknown date" rather than a bogus timestamp.
/** @param {unknown} raw */
export function parseCsbDate(raw) {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  let a, b, year;
  let slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  let dot = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (slash) {
    // M/D/Y
    [, a, b, year] = slash;
  } else if (dot) {
    // D.M.Y — swap to month/day
    [, b, a, year] = dot;
  } else {
    return undefined;
  }
  const month = Number(a);
  const day = Number(b);
  let y = Number(year);
  if (y < 100) y += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const ms = Date.UTC(y, month - 1, day);
  return Number.isFinite(ms) ? ms : undefined;
}

// jobLocationShort is an array of strings like "Karlovy Vary, CZE, 36004<br/>"
// (one per work location). Strip the trailing <br/> and any other markup, drop
// empties, and join multiple locations with " / ".
/** @param {unknown} raw */
export function cleanCsbLocation(raw) {
  const parts = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const cleaned = [];
  for (const p of parts) {
    const s = clean(String(p));
    if (s && !cleaned.includes(s)) cleaned.push(s);
  }
  return cleaned.join(' / ');
}

// Map one CSB jobs-API response to raw {id, title, url, location, postedAt}.
// Records nest the useful fields under `.response`; a record without an id or a
// title is skipped (can't build a stable dedup key or a meaningful listing).
/** @param {any} json @param {{origin:string, base?:string}} cfg @param {string} locale */
export function parseCsbJobs(json, cfg, locale) {
  const list = Array.isArray(json?.jobSearchResult) ? json.jobSearchResult : [];
  const out = [];
  for (const item of list) {
    const r = item?.response;
    if (!r) continue;
    const id = r.id != null ? String(r.id) : '';
    const title = clean(String(r.unifiedStandardTitle || r.jobTitle || ''));
    if (!id || !title) continue;
    // The site builds the slug from urlTitle/unifiedUrlTitle. The slug is purely
    // cosmetic — the server keys only on the {id}-{locale} tail (a stub slug
    // resolves the same posting) — but tenants render it inconsistently: some
    // percent-encode it ("Oper%C3%A1tor-…"), others leave HTML entities in
    // ("Mergers-&amp;-Acquisitions"). Decode entities, then drop the URL-
    // structural chars (& ? #) a raw entity would otherwise inject into the
    // path, leaving any existing %XX escapes untouched.
    const slug = decodeEntities(String(r.unifiedUrlTitle || r.urlTitle || 'job'))
      .replace(/[?#&]+/g, '-')
      .replace(/-{2,}/g, '-');
    const url = `${cfg.base || cfg.origin}/job/${slug}/${id}-${locale}`;
    out.push({
      id,
      title,
      url,
      location: cleanCsbLocation(r.jobLocationShort),
      postedAt: parseCsbDate(r.unifiedStandardStart),
    });
  }
  return out;
}

/**
 * Resolve the total-postings cap: a positive integer `max_jobs` on the entry
 * (it may raise or lower the default), else MAX_JOBS. Page safety caps scale
 * with it, so a raised cap is not cut short by the page limits below.
 */
function resolveMaxJobs(entry) {
  const v = entry?.max_jobs;
  return Number.isInteger(v) && v > 0 ? v : MAX_JOBS;
}
const pageScale = (maxJobs) => Math.max(1, Math.ceil(maxJobs / MAX_JOBS));

// ctx.maxPages is the health probe's pagination hint (verify-portals passes 1):
// stop after that many pages. Absent → no extra cap.
/** @param {any} ctx */
function probePageCap(ctx) {
  return Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity;
}

/** Resolve the per-locale page cap: positive integer `max_pages`, else default. */
function resolveCsbMaxPages(entry) {
  const cap = CSB_MAX_PAGES_PER_LOCALE * pageScale(resolveMaxJobs(entry));
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, cap);
  return cap;
}

// CSB strategy: discover locales, paginate the JSON jobs API per locale, dedup
// by id across locales+pages. `total` from the first page bounds pagination;
// an empty/short page also stops the loop.
//
// `probe: true` marks the post-RMK fallback probe: RMK already answered (the
// board is reachable, just empty of tiles), so an all-locales CSB failure must
// NOT read as a dead board — return [] instead of throwing.
/** @param {import('./_types.js').PortalEntry} entry @param {any} cfg @param {import('./_types.js').Context} ctx @param {{probe?: boolean}} [opts] */
async function fetchCsb(entry, cfg, ctx, opts = {}) {
  return (await csbCrawl(entry, cfg, ctx, opts)).jobs;
}

// The CSB crawl itself. Returns the jobs plus their ids (for cross-term dedup
// in keyword mode) and whether a page/job cap stopped it early.
/** @param {import('./_types.js').PortalEntry} entry @param {any} cfg @param {import('./_types.js').Context} ctx @param {{probe?: boolean}} [opts] */
async function csbCrawl(entry, cfg, ctx, { probe = false, locales: given = null } = {}) {
  let locales = CSB_DEFAULT_LOCALES;
  if (Array.isArray(given) && given.length) {
    locales = given; // already discovered by the caller (keyword / facet mode)
  } else {
    try {
      const html = await ctx.fetchText(cfg.searchPage, { redirect: 'error', headers: { accept: 'text/html' } });
      const discovered = extractLocales(html);
      if (discovered.length) locales = discovered;
    } catch {
      // Discovery is best-effort; fall back to the default locale set.
    }
  }

  const maxPages = Math.min(resolveCsbMaxPages(entry), probePageCap(ctx));
  const maxJobs = resolveMaxJobs(entry);
  const jobs = [];
  const ids = [];
  const seen = new Set();
  let capped = false;
  // When EVERY locale fails without a single successful request the board is
  // unreachable, not empty — THROW so scan/portal-health record a failure
  // instead of "live but empty" (meituan/tencent idiom). The FIRST failure is
  // retained and surfaced: later locales usually fail for the same root cause,
  // and keeping the first makes the thrown error deterministic.
  let succeededOnce = false;
  let firstErr = null;

  for (const locale of locales) {
    if (jobs.length >= maxJobs) break;
    let total = null;
    let page;
    for (page = 0; page < maxPages; page++) {
      let json;
      try {
        json = await ctx.fetchJson(cfg.jobsApi, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            keywords: cfg.keywords || '', locale, location: cfg.location || '', pageNumber: page, sortBy: 'recent',
            // The site's own filter (CSB student facet): {field: [values]}, values ORed.
            ...(cfg.facetFilters ? { facetFilters: cfg.facetFilters } : {}),
          }),
        });
      } catch (err) {
        firstErr ??= err;
        break; // this locale failed (e.g. 307 legacy redirect) — try the next
      }
      succeededOnce = true;
      if (total === null) {
        total = typeof json?.totalJobs === 'number' ? json.totalJobs : null;
      }
      // Page-fullness checks below use the raw response count, not rows.length:
      // parseCsbJobs drops id/title-less records, and a full API page with a
      // few dropped records would otherwise look "short" and stop pagination
      // before reaching later pages that still hold valid jobs.
      const rawCount = Array.isArray(json?.jobSearchResult) ? json.jobSearchResult.length : 0;
      if (rawCount === 0) break;
      const rows = parseCsbJobs(json, cfg, locale);

      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        const job = { title: row.title, url: row.url, company: entry.name, location: row.location };
        if (typeof row.postedAt === 'number') job.postedAt = row.postedAt;
        jobs.push(job);
        ids.push(row.id);
        if (jobs.length >= maxJobs) break;
      }
      if (jobs.length >= maxJobs) {
        capped = true;
        break;
      }
      // Stop once we've covered the reported total, or on a short page.
      if (total !== null && (page + 1) * CSB_PAGE_SIZE >= total) break;
      if (rawCount < CSB_PAGE_SIZE) break;
    }
    // The loop ran out of pages without a natural stop: more may remain.
    if (page === maxPages) capped = true;
  }
  if (!probe && !succeededOnce && firstErr) throw firstErr;
  return { jobs, ids, capped };
}

/** Tile-fragment URL for one page, carrying the careers_url search filter. @param {any} cfg @param {number} startrow */
export function tileUrl(cfg, startrow) {
  const q = cfg.searchQuery ? `${cfg.searchQuery}&` : '';
  return `${cfg.tileApi}?${q}startrow=${startrow}`;
}

// ── CSB student facet (2026-11-11) ───────────────────────────────────────────
// CSB search pages list their filter fields in the page script:
//   var facetFields = []; facetFields.push({ fieldId:"department", label:"Career Area" }) …
//   resultStyles.searchFacet.facetFields = facetFields;
// and the site's React search widget (rmk-jobs-search getFacets) reads the
// values from the same jobs API with
//   {facetingOnly:true, locale, keywords, location, facetFields:[…], facetFilters:{}}
//   → {totalJobs, facetFields:[{name, values:[{name, count}]}]}
// A value is applied as facetFilters:{<field>:[<value>, …]} (values ORed;
// Aramark department "Early Careers" → 32 of 6897, + "Culinary" → 1003).

/** CSB facet fields + labels from the search page script. @param {string} html */
export function extractCsbFacetFields(html) {
  const text = String(html || '');
  const start = text.indexOf('var facetFields');
  if (start < 0) return [];
  const end = text.indexOf('searchFacet.facetFields', start);
  const seg = text.slice(start, end > start ? end : start + 5000);
  const out = [];
  for (const m of seg.matchAll(/fieldId\s*:\s*["']([\w.-]+)["']\s*,\s*label\s*:\s*["']([^"']*)["']/g)) {
    if (!out.some((f) => f.field === m[1])) out.push({ field: m[1], label: clean(m[2]) });
  }
  return out;
}

/**
 * Discover the CSB student facet over every locale. Per-locale value counts
 * are summed, the shared picker chooses the field, and only locales where the
 * chosen values have postings are crawled. Returns null when the page lists
 * no facet fields or no faceting request succeeds.
 * @param {any} cfg @param {import('./_types.js').Context} ctx @param {string} html @param {string[]} locales @param {RegExp} re
 */
async function discoverCsbFacet(cfg, ctx, html, locales, re) {
  const fields = extractCsbFacetFields(html);
  if (!fields.length) return null;
  const perLocale = [];
  // Locales whose faceting request failed are never crawled by the facet read,
  // so the caller marks that read incomplete instead of reporting a full board.
  const failedLocales = [];
  let boardTotal = 0;
  for (const locale of locales) {
    let json;
    try {
      json = await ctx.fetchJson(cfg.jobsApi, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ facetingOnly: true, locale, keywords: cfg.keywords || '', location: cfg.location || '', facetFields: fields.map((f) => f.field), facetFilters: {} }),
      });
    } catch {
      failedLocales.push(locale);
      continue;
    }
    if (typeof json?.totalJobs === 'number') boardTotal += json.totalJobs;
    const counts = {};
    for (const f of Array.isArray(json?.facetFields) ? json.facetFields : []) {
      if (!f || typeof f.name !== 'string' || !Array.isArray(f.values)) continue;
      const m = new Map();
      for (const v of f.values) if (v && typeof v.name === 'string' && v.name) m.set(v.name, (m.get(v.name) || 0) + (Number(v.count) || 0));
      counts[f.name] = m;
    }
    perLocale.push({ locale, counts });
  }
  if (!perLocale.length) return null;
  const merged = {};
  for (const { counts } of perLocale) {
    for (const [field, m] of Object.entries(counts)) {
      const acc = (merged[field] ??= new Map());
      for (const [name, count] of m) acc.set(name, (acc.get(name) || 0) + count);
    }
  }
  const map = {};
  for (const [field, m] of Object.entries(merged)) map[field] = [...m].map(([name, count]) => ({ name, count }));
  const facet = pickStudentFacet({ facets: { map } }, fields, re);
  // Summed per-locale totals: an upper bound (a posting can be published in
  // several locales), reported only.
  if (!facet) return { facet: null, locales: [], boardTotal };
  const hitLocales = perLocale
    .filter(({ counts }) => facet.values.some((v) => (counts[facet.name]?.get(v) || 0) > 0))
    .map((p) => p.locale);
  return { facet, locales: hitLocales, boardTotal, failedLocales };
}

// RMK strategy: the original /tile-search-results/ HTML-fragment scraper.
/** @param {import('./_types.js').PortalEntry} entry @param {any} cfg @param {import('./_types.js').Context} ctx */
async function fetchRmk(entry, cfg, ctx) {
  return (await rmkCrawl(entry, cfg, ctx)).jobs;
}

// The RMK crawl itself. Returns the jobs plus their tile ids (for cross-term
// dedup in keyword mode) and whether max_jobs or the page cap stopped it.
/** @param {import('./_types.js').PortalEntry} entry @param {any} cfg @param {import('./_types.js').Context} ctx */
// `expected` (a count the site stated for this view) stops the crawl once
// that many postings are read: past the last page some tenants (Under Armour
// 2026-11-11) return a fixed block of unrelated postings instead of nothing.
async function rmkCrawl(entry, cfg, ctx, { expected = null } = {}) {
  if (expected === 0) return { jobs: [], ids: [], capped: false };
  const maxJobs = resolveMaxJobs(entry);
  const maxPages = Math.min(MAX_PAGES * pageScale(maxJobs), probePageCap(ctx));
  const jobs = [];
  const ids = [];
  const seen = new Set();
  let capped = false;
  let startrow = 0;
  let page;
  for (page = 0; page < maxPages; page++) {
    const htmlText = await ctx.fetchText(tileUrl(cfg, startrow), {
      redirect: 'error',
      headers: { accept: 'text/html' },
    });
    const tiles = parseTiles(htmlText, cfg.jobBase);
    if (tiles.length === 0) break;

    let fresh = 0;
    for (const tile of tiles) {
      if (seen.has(tile.id)) continue;
      seen.add(tile.id);
      fresh++;
      ids.push(tile.id);
      jobs.push({
        title: tile.title,
        url: tile.url,
        company: entry.name,
        location: tile.location,
      });
    }
    // No new ids this page → server ignored the offset (or we've looped). Stop.
    if (fresh === 0) break;
    if (expected !== null && jobs.length >= expected && jobs.length < maxJobs) break;
    if (jobs.length >= maxJobs) {
      capped = true;
      console.error(`⚠️  successfactors: ${entry.name} stopped at max_jobs=${maxJobs} — raise max_jobs on this entry for more`);
      break;
    }
    startrow += tiles.length;
    if (page === maxPages - 1) {
      console.error(`⚠️  successfactors: ${entry.name} truncated at ${maxPages} tile pages (${jobs.length} jobs) — raise max_jobs on this entry for more`);
    }
  }
  if (page === maxPages) capped = true;
  // The cap is checked between pages, so the last page can overshoot it; a
  // stated count trims the same way (anything past it is the filler block).
  const keep = expected !== null && expected < maxJobs ? expected : maxJobs;
  return { jobs: jobs.slice(0, keep), ids: ids.slice(0, keep), capped };
}

// ── Keyword search (2026-11-09) ──────────────────────────────────────────────
// Big boards are read through the site's own search instead of paging the
// whole board: entry.keywords (array of terms, filled in by the caller) runs
// the normal crawl once per term with the term as the search filter, and
// entry.keyword_min_total keeps boards at or below that size on the full
// fetch. RMK: the term becomes `q=` on every /tile-search-results/ request
// (the same mechanism as a careers_url search filter; other filter params such
// as locationsearch are kept, a configured q is replaced). CSB: the term goes
// into the jobs-API `keywords` body field. The site's search is a word/prefix
// match over title AND description (Sephora "intern" also hits "Interim" and
// "Internal Control"), so keyword results are a superset to be filtered later.

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

// The RMK /search/ page states the result count in its pagination label:
//   <span class="paginationLabel" aria-label="Results 1 – 25">Results <b>1 – 25</b> of <b>173</b></span>
// The last <b> number inside the label is the total (thousands separators
// stripped). A board with no hits renders no label → null (unknown).
/** @param {string} html */
// Tile-layout tenants (Under Armour, Compass, Edison 2026-11-11) render no
// label; their page script states the count instead:
//   j2w.SearchResults.init({ …, jobRecordsPerPage: parseInt("10"), jobRecordsFound: parseInt("724") });
export function parseRmkTotal(html) {
  const text = String(html || '');
  const label = text.match(/class="paginationLabel"[^>]*>([\s\S]*?)<\/span>/);
  if (!label) {
    const found = text.match(/jobRecordsFound\s*:\s*parseInt\(\s*["'](\d+)["']\s*\)/);
    return found ? Number(found[1]) : null;
  }
  const nums = [...label[1].matchAll(/<b>\s*([\d.,\s  ]+?)\s*<\/b>/g)].map((m) => m[1].replace(/\D/g, ''));
  const last = nums.length ? nums[nums.length - 1] : '';
  if (!last) return null;
  const n = Number(last);
  return Number.isFinite(n) ? n : null;
}

/** The RMK /search/ page (careers_url filter kept); null when it cannot be read. @param {any} cfg @param {import('./_types.js').Context} ctx */
async function rmkSearchPage(cfg, ctx) {
  const q = cfg.searchQuery ? `${cfg.searchQuery}&` : '';
  try {
    return await ctx.fetchText(`${cfg.searchPage}?${q}startrow=0`, { redirect: 'error', headers: { accept: 'text/html' } });
  } catch {
    return null; // unknown total → treated as a big board; no facet discovery
  }
}

// ── Student facet (2026-11-09) ───────────────────────────────────────────────
// RMK search pages carry the tenant's own filter dropdowns ("Employee Class",
// "Experience Level", …). Their fields are listed in the page script
//   j2w.search.options = { isOpen: false, facets: ["customfield1","customfield2","shifttype"], … };
// with a label per field (<label id="optionsFacetsDD_<field>_label">), but the
// option values are loaded client-side by options-search.js from
//   POST {base}/services/jobs/options/facetValues/  → {facets:{map:{<field>:[{name,translated,count}]}}}
// A value is applied as `optionsFacetsDD_<field>=<name>` on /search/ and
// /tile-search-results/ (Sephora: customfield2=Intern/Trainee → 19 of 1246;
// Hershey: customfield1=Interns → 11 of 329). When some value means student
// roles, keyword mode reads those facet views first; keyword search is the
// fallback when no value matches or the facet views come back empty.
// `intern` must not match International/Internal.
// Shared facet-selection rule (all providers, 2026-11-09):
// - a facet whose NAME or LABEL names a place/title/brand dimension is never
//   the student facet (the field name may be a generic customfieldN);
// - a facet with more than FACET_MAX_VALUES values is free text, skipped;
// - worker-type facets are preferred; within a rank the facet with the FEWEST
//   matching jobs (> 0) wins; values are never merged across facets.
const NON_CATEGORY_FACET_RE = /\b(?:locations?|cit(?:y|ies)|states?|countr(?:y|ies)|regions?|zip|postal|stores?|sites?|titles?|job titles?|brands?|department codes?)\b/i;
const CATEGORY_FACET_RE = /employee class|employment type|job type|worker type|time type|category|experience level|career level|job family|tags?\b/i;
const FACET_MAX_VALUES = 200;
// "Internal" / "International" are never intern values, whatever words are
// configured: those words are removed before the matcher runs, and a value
// that was nothing else is rejected.
const INTERNAL_WORDS_RE = /\bintern(?:al|ation)\w*/gi;
// Site-returned values are capped before matching (a longer value cannot be a
// category tag anyway).
const FACET_VALUE_MAX_CHARS = 200;
/** @param {RegExp} re @param {string} text */
function facetValueMatches(re, text) {
  if (!text) return false;
  const rest = String(text).slice(0, FACET_VALUE_MAX_CHARS).replace(INTERNAL_WORDS_RE, ' ').trim();
  if (!rest) return false;
  re.lastIndex = 0;
  return re.test(rest);
}
// Built-in word list (widened 2026-11-09 by the user: contract and master's-
// level values are wanted too, "effect bad → remove later"). entry.facet_values
// (portals.yml keyword_search.facet_values via the bridge) is an ARRAY of plain
// words/phrases that replaces it; never a regular expression.
const DEFAULT_FACET_WORDS = ['intern', 'internship', 'co-op', 'student', 'contract', 'master', 'graduate', 'early career', 'early talent', 'campus', 'university', 'apprentice'];

/**
 * Facet value matcher from a word list: every word escaped, whole-word,
 * case-insensitive, optional plural / 's suffix, so "Interns", "Master's
 * Program" and "Working Students" match. Non-string entries are ignored; an
 * empty list (or anything that is not an array) means the built-in words.
 * @param {unknown} words
 */
export function facetValueMatcher(words) {
  const list = (Array.isArray(words) ? words : [])
    .filter((w) => typeof w === 'string')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  const use = list.length ? [...new Set(list)] : DEFAULT_FACET_WORDS;
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'); // u-mode: only syntax chars may be escaped
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${use.map(esc).join('|')})(?:s|['\u2019]s)?(?![\\p{L}\\p{N}])`, 'iu');
}
const STUDENT_FACET_RE = facetValueMatcher([]);

/** Facet fields + labels from the search page script. @param {string} html */
export function extractFacetFields(html) {
  const text = String(html || '');
  const m = text.match(/j2w\.search\.options\s*=\s*\{[\s\S]*?facets\s*:\s*\[([^\]]*)\]/);
  let fields = m ? [...m[1].matchAll(/["']([\w.-]+)["']/g)].map((x) => x[1]) : [];
  if (!fields.length) fields = [...new Set([...text.matchAll(/<select[^>]*name="optionsFacetsDD_([\w.-]+)"/g)].map((x) => x[1]))];
  return fields.map((field) => {
    const lm = text.match(new RegExp(`id="optionsFacetsDD_${field.replace(/[.-]/g, '\\$&')}_label"[^>]*>([\\s\\S]*?)<\\/label>`));
    return { field, label: lm ? clean(lm[1]) : '' };
  });
}

/**
 * Pick the student facet from a facetValues response: the field whose
 * matching values cover the most postings, with those values in site order.
 * @param {any} json @param {{field:string,label:string}[]} fields
 * @returns {{name:string,label:string,values:string[]}|null}
 */
export function pickStudentFacet(json, fields, re = STUDENT_FACET_RE) {
  const map = json?.facets?.map;
  if (!map || typeof map !== 'object') return null;
  let best = null;
  for (const { field, label } of fields) {
    const lbl = label || '';
    if (NON_CATEGORY_FACET_RE.test(field) || NON_CATEGORY_FACET_RE.test(lbl)) continue;
    const vals = Array.isArray(map[field]) ? map[field] : [];
    if (vals.length > FACET_MAX_VALUES) continue;
    const hits = vals.filter((v) => v && typeof v.name === 'string' && v.name && (facetValueMatches(re, v.name) || facetValueMatches(re, String(v.translated || ''))));
    if (!hits.length) continue;
    const count = hits.reduce((n, v) => n + (Number(v.count) || 0), 0);
    if (count <= 0) continue;
    const rank = CATEGORY_FACET_RE.test(field) || CATEGORY_FACET_RE.test(lbl) ? 1 : 0;
    if (!best || rank > best.rank || (rank === best.rank && count < best.count)) {
      best = { name: field, label, values: hits.map((v) => v.name), count, rank };
    }
  }
  if (!best) return null;
  return { name: best.name, label: best.label, values: best.values };
}

/** Discover the student facet; null when the tenant has none (or discovery fails). @param {any} cfg @param {import('./_types.js').Context} ctx @param {string} html */
async function discoverStudentFacet(cfg, ctx, html, re) {
  const fields = extractFacetFields(html);
  if (!fields.length) return null;
  try {
    const json = await ctx.fetchJson(`${cfg.base}/services/jobs/options/facetValues/`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      // Same body options-search.js sends; the careers_url filter is kept.
      body: JSON.stringify({
        page: 0, keywords: cfg.keywords || '', locationsearch: cfg.location || '',
        sortby: 'referencedate', sortdir: 'desc', sortfield: 'title', recordsperpage: 25, startrow: 0,
        facetquery: { facet: true, mincount: 1, limit: 5000, fields: fields.map((f) => f.field), sort: 'index', showPicklistAllLocales: false },
        filterquery: {},
      }),
    });
    return pickStudentFacet(json, fields, re);
  } catch {
    return null;
  }
}

/** Config for one facet value: optionsFacetsDD_<field>=<value> on the tile requests. @param {any} cfg @param {string} field @param {string} value */
export function facetConfig(cfg, field, value) {
  const sp = new URLSearchParams(cfg.searchQuery);
  sp.set(`optionsFacetsDD_${field}`, value);
  return { ...cfg, searchQuery: sp.toString() };
}

// Merge per-run crawl results (run order, then page order; dedup by id, URL
// as fallback) into one marked array.
/** @param {string[]} keys @param {{jobs:any[],ids:string[],capped:boolean}[]} results @param {object} marker */
function mergeRuns(keys, results, marker) {
  const jobs = [];
  const seen = new Set();
  const perTerm = {};
  let truncated = false;
  keys.forEach((key, i) => {
    const r = results[i];
    perTerm[key] = r.jobs.length;
    if (r.capped) truncated = true;
    r.jobs.forEach((job, j) => {
      const k = r.ids[j] ? `id:${r.ids[j]}` : `url:${job.url}`;
      if (seen.has(k)) return;
      seen.add(k);
      jobs.push(job);
    });
  });
  Object.defineProperty(jobs, 'keywordSearch', {
    value: { ...marker, perTerm },
    enumerable: true, writable: true, configurable: true,
  });
  if (truncated) jobs.truncated = true;
  return jobs;
}

// Read the student facet views; null when they yield nothing (→ keywords).
/** @param {import('./_types.js').PortalEntry} entry @param {any} cfg @param {import('./_types.js').Context} ctx @param {{name:string,label:string,values:string[]}} facet @param {number|null} boardTotal @param {number} termCount */
async function fetchByFacet(entry, cfg, ctx, facet, boardTotal, termCount) {
  const results = [];
  for (const value of facet.values) results.push(await rmkCrawl(entry, facetConfig(cfg, facet.name, value), ctx));
  if (results.every((r) => r.jobs.length === 0)) return null;
  return mergeRuns(facet.values, results, { mode: 'facet', facet, terms: termCount, boardTotal });
}

// RMK search ORs the words of an unquoted query (Sephora 2026-11-09:
// q=summer associate → 1001 hits ≈ the whole board, "associate" alone 995),
// while a double-quoted query is a phrase search ("early career" 7 vs 226
// unquoted). A multi-word term is therefore sent quoted; single words and
// terms the caller already quoted go as-is.
// The CSB jobs API behaves the same way (Aramark 2026-11-11, en_US, board
// 6897: keywords `early career` → 6843 hits, `graduate program` → 3012, so the
// term crawl hit max_jobs and the whole read came back truncated; quoted
// `"early career"` → 35, `"graduate program"` → 0), so the quoted phrase goes
// into the CSB `keywords` body field too.
/** Config for one search term: q=<term> on the tile requests, keywords=<term> on CSB. @param {any} cfg @param {string} term */
export function termConfig(cfg, term) {
  const sp = new URLSearchParams(cfg.searchQuery);
  const q = /\s/.test(term) && !/^".*"$/.test(term) ? `"${term}"` : term;
  sp.set('q', q);
  return { ...cfg, searchQuery: sp.toString(), keywords: q };
}

// Today's full-board fetch (no keywords).
/** @param {import('./_types.js').PortalEntry} entry @param {any} cfg @param {import('./_types.js').Context} ctx */
async function fetchFull(entry, cfg, ctx) {
  // Explicit opt-in goes straight to CSB. RMK tenants (the majority) run the
  // tile scraper; only when it comes back empty — the CSB empty-shell
  // signature — do we auto-fall back to the JSON API, so an unflagged CSB
  // tenant still works and a genuinely-empty RMK board costs one extra probe.
  if (String(entry.sfVariant || '').toLowerCase() === 'csb') {
    return fetchCsb(entry, cfg, ctx);
  }
  // A category page is an RMK filter view; an empty one is just empty.
  if (cfg.category) return (await rmkCrawl(entry, cfg, ctx, { expected: await categoryCount(cfg, ctx) })).jobs;
  const rmkJobs = await fetchRmk(entry, cfg, ctx);
  if (rmkJobs.length > 0) return rmkJobs;
  // RMK answered (healthy, possibly legitimately empty) — the CSB call here
  // is only a probe for the empty-shell signature, so it must not turn a
  // failing/absent CSB endpoint into a dead-board throw.
  return fetchCsb(entry, cfg, ctx, { probe: true });
}

// Run the crawl once per term and merge: term order, then page order; dedup by
// job id (URL as fallback). Marks the array with keywordSearch and truncated.
/** @param {import('./_types.js').PortalEntry} entry @param {any} cfg @param {import('./_types.js').Context} ctx @param {string[]} terms @param {number|null} boardTotal */
async function fetchByKeywords(entry, cfg, ctx, terms, boardTotal, html = null) {
  const isCsb = String(entry.sfVariant || '').toLowerCase() === 'csb';
  if (!isCsb) {
    const results = [];
    for (const term of terms) results.push(await rmkCrawl(entry, termConfig(cfg, term), ctx));
    // Every term empty: either no matches on an RMK board, or a CSB tenant
    // whose tile endpoint is an empty shell. One unfiltered tile page tells
    // them apart; only the empty shell switches to the CSB API.
    if (results.every((r) => r.jobs.length === 0)) {
      const probe = await ctx.fetchText(tileUrl(cfg, 0), { redirect: 'error', headers: { accept: 'text/html' } });
      if (parseTiles(probe, cfg.jobBase).length === 0) return fetchCsbSearch(entry, cfg, ctx, terms, boardTotal, html, true);
    }
    return mergeRuns(terms, results, { mode: 'keywords', terms: terms.length, boardTotal });
  }
  return fetchCsbSearch(entry, cfg, ctx, terms, boardTotal, html, false);
}

// CSB search: the student facet first (entry.facet: false skips it), then one
// keyword query per term. Locales come from the search page when it was read.
/** @param {import('./_types.js').PortalEntry} entry @param {any} cfg @param {import('./_types.js').Context} ctx @param {string[]} terms @param {number|null} boardTotal @param {string|null} html @param {boolean} probe */
async function fetchCsbSearch(entry, cfg, ctx, terms, boardTotal, html, probe) {
  const pageLocales = html ? extractLocales(html) : [];
  if (entry.facet !== false && html) {
    const found = await discoverCsbFacet(cfg, ctx, html, pageLocales.length ? pageLocales : CSB_DEFAULT_LOCALES, facetValueMatcher(entry.facet_values));
    if (found && boardTotal === null && found.boardTotal > 0) boardTotal = found.boardTotal;
    if (found?.facet && found.locales.length) {
      const r = await csbCrawl(entry, { ...cfg, facetFilters: { [found.facet.name]: found.facet.values } }, ctx, { probe, locales: found.locales });
      if (r.jobs.length) {
        const merged = mergeRuns([found.facet.values.join(' | ')], [r], { mode: 'facet', facet: found.facet, terms: terms.length, boardTotal });
        if (found.failedLocales?.length) {
          console.error(`⚠️  successfactors: ${entry.name} facet read truncated — faceting failed for locale(s) ${found.failedLocales.join(', ')}`);
          merged.truncated = true;
        }
        return merged;
      }
    }
  }
  const results = [];
  for (const term of terms) results.push(await csbCrawl(entry, termConfig(cfg, term), ctx, { probe, locales: pageLocales }));
  return mergeRuns(terms, results, { mode: 'keywords', terms: terms.length, boardTotal });
}

/** The count a category page states for itself; null when it cannot be read. @param {any} cfg @param {import('./_types.js').Context} ctx */
async function categoryCount(cfg, ctx) {
  try {
    return parseRmkTotal(await ctx.fetchText(cfg.category.page, { redirect: 'error', headers: { accept: 'text/html' } }));
  } catch {
    return null; // no stated count: page until the tiles run out
  }
}

// A configured category page (careers_url …/go/<Name>/<id>/) read in keyword
// mode: the category is the site's own filter, so it is read instead of the
// keyword queries and reported as a facet read.
/** @param {import('./_types.js').PortalEntry} entry @param {any} cfg @param {import('./_types.js').Context} ctx @param {string[]} terms */
async function fetchByCategory(entry, cfg, ctx, terms) {
  // The unfiltered search page gives the whole-board count for the receipt;
  // the category page states the category's own count, which ends the crawl.
  const html = await rmkSearchPage(cfg, ctx);
  const boardTotal = html === null ? null : parseRmkTotal(html);
  const r = await rmkCrawl(entry, cfg, ctx, { expected: await categoryCount(cfg, ctx) });
  const facet = { name: 'category', label: 'Category', values: [cfg.category.name] };
  return mergeRuns([cfg.category.name], [r], { mode: 'facet', facet, terms: terms.length, boardTotal });
}

/** @type {Provider} */
export default {
  id: 'successfactors',

  detect(entry) {
    const url = entry.api || entry.careers_url || '';
    if (/successfactors\.(eu|com)|jobs2web\.com/i.test(url)) return { url };
    return null;
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry);
    if (!cfg) throw new Error(`successfactors: cannot resolve origin for ${entry.name}`);

    const terms = normalizeKeywords(entry.keywords);
    // A health probe (ctx.maxPages) only checks the board is live: unfiltered
    // pages, no facet or keyword requests, no keywordSearch marker.
    if (!terms.length || probePageCap(ctx) !== Infinity) return fetchFull(entry, cfg, ctx);
    // A configured category page is already the site's own filter.
    if (cfg.category) return fetchByCategory(entry, cfg, ctx, terms);

    // keyword_min_total: keep small boards on the full fetch. The total comes
    // from the RMK /search/ page; CSB boards (and a page without a count) give
    // no total, which counts as "bigger than the threshold".
    const isCsb = String(entry.sfVariant || '').toLowerCase() === 'csb';
    const useFacet = entry.facet !== false && !isCsb;
    const minTotal = Number.isInteger(entry.keyword_min_total) && entry.keyword_min_total > 0 ? entry.keyword_min_total : null;
    let boardTotal = null;
    let html = null;
    // CSB reads the page too: its locale links and facet field list.
    if (isCsb ? entry.facet !== false : minTotal !== null || useFacet) html = await rmkSearchPage(cfg, ctx);
    if (minTotal !== null && !isCsb) {
      boardTotal = html === null ? null : parseRmkTotal(html);
      if (boardTotal !== null && boardTotal <= minTotal) return fetchFull(entry, cfg, ctx);
    }
    // The site's own student tag first (entry.facet: false skips it), then
    // the keyword search.
    if (useFacet && html !== null) {
      const facet = await discoverStudentFacet(cfg, ctx, html, facetValueMatcher(entry.facet_values));
      if (facet) {
        const byFacet = await fetchByFacet(entry, cfg, ctx, facet, boardTotal, terms.length);
        if (byFacet) return byFacet;
      }
    }
    return fetchByKeywords(entry, cfg, ctx, terms, boardTotal, html);
  },
};
