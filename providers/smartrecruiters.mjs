// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// SmartRecruiters provider — hits the public postings API.
// Auto-detects from careers_url pattern
// `https://(careers|jobs).smartrecruiters.com/<slug>`. A tracked_companies
// entry can also set `provider: smartrecruiters` explicitly to bypass
// detection (useful when the public careers URL is a branded custom domain).
//
// The list payload carries NO description body. Boards that need it opt in
// via tracked_companies config (mirrors vdab):
//
//   smartrecruiters:
//     fetchDetails: true   # fetch each posting's detail JSON for descriptions
//     detailLimit: 25      # max detail calls per sweep when fetchDetails=true
//
// Detail enrichment answers "what does this job say", not "is this endpoint
// alive" — it is skipped entirely while verify-portals is probing, and runs
// in small batches so a 400-posting board cannot hammer the shared API host.

import { intInRange } from './_config-utils.mjs';
import { htmlToText } from './_html-to-text.mjs';

const ALLOWED_SMARTRECRUITERS_HOSTS = new Set(['api.smartrecruiters.com']);
const SR_CAREERS_HOSTS = new Set(['careers.smartrecruiters.com', 'jobs.smartrecruiters.com']);
const SR_PAGE_SIZE = 100;
const SR_MAX_PAGES = 50;  // default safety cap (5000 postings @ 100/page); entry `max_pages` overrides
const SR_DETAIL_BATCH = 5;

/**
 * @param {any} entry
 * @returns {{ fetchDetails: boolean, detailLimit: number }}
 */
function parseSmartRecruitersConfig(entry) {
  const cfg = (entry && entry.smartrecruiters) || {};
  return {
    fetchDetails: cfg.fetchDetails === true,
    detailLimit: intInRange(cfg.detailLimit, 25, 1, 100),
  };
}

/**
 * Extracts the best plain-text description from a posting-detail response.
 *
 * The detail payload nests HTML bodies under `jobAd.sections`, keyed by a
 * fixed section set (companyDescription, jobDescription, qualifications,
 * additionalInformation). Joined in that order — company context first,
 * call-to-action last — then stripped by the shared pipeline.
 *
 * @param {any} detail
 * @returns {string}
 */
export function extractDescription(detail) {
  const sections = detail?.jobAd?.sections;
  if (!sections || typeof sections !== 'object') return '';
  const parts = [];
  for (const key of ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation']) {
    const text = sections[key]?.text;
    if (typeof text === 'string' && text.trim()) parts.push(text);
  }
  if (parts.length === 0) return '';
  return htmlToText(parts.join('\n'));
}

function assertSmartRecruitersUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`smartrecruiters: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`smartrecruiters: URL must use HTTPS: ${url}`);
  if (!ALLOWED_SMARTRECRUITERS_HOSTS.has(parsed.hostname)) {
    throw new Error(`smartrecruiters: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_SMARTRECRUITERS_HOSTS].join(', ')}`);
  }
  return url;
}

function resolveSlug(entry) {
  // entry.api takes precedence over careers_url (mirrors greenhouse/ashby) so a
  // branded page (e.g. https://jobs.continental.com) can stay as careers_url
  // while the SmartRecruiters slug is pinned via
  // api: https://careers.smartrecruiters.com/<slug> in portals.yml.
  for (const raw of [entry.api, entry.careers_url]) {
    if (typeof raw !== 'string' || !raw) continue;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:') continue;
    if (!SR_CAREERS_HOSTS.has(parsed.hostname)) continue;
    const slug = parsed.pathname.split('/').filter(Boolean)[0];
    if (slug) return slug;
  }
  return null;
}

// Student-role facet: the platform's own posting tag `experienceLevel`, value
// id `internship` (SmartRecruiters' fixed experience-level list). Live
// 2026-11-09 the public postings API (and jobs.smartrecruiters.com/sr-jobs/
// search) silently IGNORES `experienceLevel=` — it returns the whole board —
// so a facet result only counts when it is provably filtered (see
// facetUsable). The probe is therefore OFF by default (no request) and runs
// only when the entry sets `facet: true`.
// The platform's fixed experienceLevel enum (id → label as shown on postings).
const SR_FACET_NAME = 'experienceLevel';
const SR_EXPERIENCE_LEVELS = Object.freeze([
  ['internship', 'Internship'],
  ['entry_level', 'Entry level'],
  ['associate', 'Associate'],
  ['mid_senior_level', 'Mid-Senior level'],
  ['director', 'Director'],
  ['executive', 'Executive'],
  ['not_applicable', 'Not Applicable'],
]);
const SR_DEFAULT_FACET_ID = 'internship';  // used when entry.facet_values is absent / empty
const SR_FACET_VALUE_MAX = 200;            // tag ids/labels are cut to this before matching
// "Internal …" / "International …" never count as a student tag, whatever the
// words say: they are removed from the value before the words are matched.
const SR_FACET_NOISE = /\bintern(?:al|ational)\b/gi;

/**
 * The experienceLevel values to probe: with `entry.facet_values` (an array of
 * plain words / phrases) every enum value whose id or label contains one of
 * the words; without it the `internship` id only.
 *
 * @param {any} entry
 * @returns {string[]}
 */
export function selectFacetValues(entry) {
  const words = parseFacetValues(entry);
  if (words.length === 0) return SR_EXPERIENCE_LEVELS.filter(([id]) => id === SR_DEFAULT_FACET_ID).map(([id]) => id);
  const matches = facetValueMatcher(words);
  return SR_EXPERIENCE_LEVELS.filter(([id, label]) => matches(id) || matches(label)).map(([id]) => id);
}

/**
 * Build a matcher for tag values from plain words / phrases: each word is
 * escaped (never a regular expression), may carry a plural or possessive
 * suffix (`s`, `'s`), must stand as a whole word (letters/digits on either
 * side break the match; `_`, `-` and spaces are interchangeable separators on
 * both sides, so "entry" matches the id `entry_level` and "co-op" matches
 * `co_op`), and is compared case-insensitively. The value is cut
 * to SR_FACET_VALUE_MAX characters and stripped of internal/international
 * first.
 *
 * @param {string[]} words
 * @returns {(value: unknown) => boolean}
 */
export function facetValueMatcher(words) {
  const patterns = words.map((w) => {
    const body = w.split(/[\s_-]+/).filter(Boolean).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s_-]+');
    return new RegExp(`(?<![A-Za-z0-9])${body}(?:'?s)?(?![A-Za-z0-9])`, 'i');
  });
  return (value) => {
    if (typeof value !== 'string') return false;
    const cleaned = value.slice(0, SR_FACET_VALUE_MAX).replace(SR_FACET_NOISE, ' ');
    return patterns.some((re) => re.test(cleaned));
  };
}

/**
 * @param {string} slug
 * @param {number} [offset]
 * @param {string | { name: string, values: readonly string[] } | null} [filter]
 *   a search term (→ `q=`) or a facet (→ `<name>=<value>` per value)
 */
function buildPostingsUrl(slug, offset = 0, filter = null) {
  const base = `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=${SR_PAGE_SIZE}&offset=${offset}&status=PUBLIC`;
  if (!filter) return base;
  if (typeof filter === 'string') return `${base}&q=${encodeURIComponent(formatSearchTerm(filter))}`;
  return base + filter.values.map((v) => `&${encodeURIComponent(filter.name)}=${encodeURIComponent(v)}`).join('');
}

/**
 * Is a facet-filtered first page really filtered? The API answers unknown
 * filter parameters with the unfiltered board, so require: a reported total
 * that is > 0 and smaller than the board total (when known), and every
 * returned row carrying one of the requested value ids.
 *
 * @param {any} json
 * @param {number | null} boardTotal
 * @param {{ name: string, values: readonly string[] }} facet
 * @returns {string | null} null when usable, else the reason it is not
 */
export function facetUsable(json, boardTotal, facet) {
  const total = json?.totalFound;
  const items = json?.content;
  if (!Number.isFinite(total) || !Array.isArray(items)) return 'no totalFound';
  if (total === 0 || items.length === 0) return 'empty';
  if (boardTotal !== null && total >= boardTotal) return 'filter ignored';
  const ok = items.every((j) => facet.values.includes(j?.[facet.name]?.id));
  return ok ? null : 'rows not tagged';
}

/**
 * The postings API full-text-searches `q` over title AND description. A bare
 * multi-word or hyphenated term is split into words (live 2026-11-09, Domino's:
 * `q=co-op` → 8,108 hits, `q="co-op"` → 1; `q=summer associate` → 7,422,
 * quoted → 0), so such terms are sent as a quoted phrase. Single words and
 * already-quoted terms pass through unchanged.
 *
 * @param {string} term
 * @returns {string}
 */
export function formatSearchTerm(term) {
  const t = term.trim();
  if (/^".*"$/.test(t)) return t;
  return /[\s-]/.test(t) ? `"${t}"` : t;
}

/**
 * Keyword-search settings from the entry (filled in by the caller):
 * `keywords` (array of strings; absent / empty / false → full board) and
 * `keyword_min_total` (positive integer → search only boards bigger than it;
 * absent → always search when keywords are set).
 *
 * @param {any} entry
 * @returns {{ terms: string[], minTotal: number | null }}
 */
export function parseKeywordConfig(entry) {
  const raw = Array.isArray(entry?.keywords) ? entry.keywords : [];
  const seen = new Set();
  const terms = [];
  for (const k of raw) {
    if (typeof k !== 'string') continue;
    const t = k.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    terms.push(t);
  }
  const m = entry?.keyword_min_total;
  return { terms, minTotal: Number.isInteger(m) && m > 0 ? m : null };
}

/**
 * `entry.facet_values`: optional ARRAY of plain words / phrases (never a
 * regular expression) naming which experienceLevel tags count as student
 * roles. Non-strings and blanks are dropped, duplicates collapsed. Absent,
 * not an array, or empty → [] (the caller then uses the built-in default).
 *
 * @param {any} entry
 * @returns {string[]}
 */
export function parseFacetValues(entry) {
  const raw = Array.isArray(entry?.facet_values) ? entry.facet_values : [];
  const seen = new Set();
  const words = [];
  for (const w of raw) {
    if (typeof w !== 'string') continue;
    const t = w.trim().replace(/\s+/g, ' ');
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    words.push(t);
  }
  return words;
}

function buildPostingDetailUrl(slug, id) {
  return `https://api.smartrecruiters.com/v1/companies/${slug}/postings/${encodeURIComponent(id)}`;
}

function resolveApiUrl(entry) {
  const slug = resolveSlug(entry);
  return slug ? buildPostingsUrl(slug, 0) : null;
}

/** @type {Provider} */
export default {
  id: 'smartrecruiters',

  detect(entry) {
    const apiUrl = resolveApiUrl(entry);
    return apiUrl ? { url: apiUrl } : null;
  },

  async fetch(entry, ctx) {
    const slug = resolveSlug(entry);
    if (!slug) throw new Error(`smartrecruiters: cannot derive API URL for ${entry.name}`);

    // Honor the ctx.maxPages pagination hint (the portal health probe passes 1);
    // a real sweep keeps the SR_MAX_PAGES safety cap unless the entry sets a
    // positive integer `max_pages`, which replaces it (up or down).
    const entryPages = Number.isInteger(entry?.max_pages) && entry.max_pages > 0 ? entry.max_pages : SR_MAX_PAGES;
    const pageLimit = Math.min(
      entryPages,
      Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity,
    );

    // One paginated walk over the postings list (optionally filtered by a
    // search term). `first` reuses an already-fetched offset-0 page. `capped`
    // means the page cap stopped a walk whose last page was still full.
    const walk = async (filter, first) => {
      const rows = [];
      let capped = false;
      for (let page = 0; page < pageLimit; page++) {
        let json;
        if (page === 0 && first !== undefined) {
          json = first;
        } else {
          const apiUrl = buildPostingsUrl(slug, page * SR_PAGE_SIZE, filter);
          assertSmartRecruitersUrl(apiUrl);
          json = await ctx.fetchJson(apiUrl, { redirect: 'error' });
        }
        const parsed = parseSmartRecruitersResponse(json, entry.name);
        if (parsed.length === 0) break;
        rows.push(...parsed);
        if (parsed.length < SR_PAGE_SIZE) break;  // last page (short)
        if (page === pageLimit - 1) capped = true;
      }
      return { rows, capped };
    };

    // Keyword search (entry.keywords / entry.keyword_min_total): the first
    // unfiltered page reports `totalFound`; a board no bigger than the
    // threshold is still read whole (reusing that page). A bigger one is
    // first read through the platform's student facet (unless
    // `entry.facet === false`); when that filter errors or is not provably
    // applied, it is read once per term through the API's `q` full-text
    // filter. Skipped while probing — a liveness check only needs one page.
    const { terms, minTotal } = parseKeywordConfig(entry);
    const probingList = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0;
    let all;
    /** @type {null | Record<string, any>} */
    let keywordSearch = null;
    let truncated = false;
    if (terms.length > 0 && !probingList) {
      const firstUrl = buildPostingsUrl(slug, 0);
      assertSmartRecruitersUrl(firstUrl);
      const firstJson = await ctx.fetchJson(firstUrl, { redirect: 'error' });
      const boardTotal = Number.isFinite(firstJson?.totalFound) ? firstJson.totalFound : null;
      if (minTotal !== null && boardTotal !== null && boardTotal <= minTotal) {
        all = (await walk(null, firstJson)).rows;
      } else {
        /** @type {null | { rows: any[], capped: boolean, values: string[], perValue: Record<string, number> }} */
        let facetResult = null;
        let facetFallback = null;
        if (entry?.facet === true) {
          // One probe per selected value; any value whose filter is ignored
          // (or errors) makes the whole facet unusable → keywords for all.
          const values = selectFacetValues(entry);
          if (values.length === 0) facetFallback = 'no facet value matches';
          try {
            const merged = [];
            const seenFacet = new Set();
            /** @type {Record<string, number>} */
            const perValue = {};
            let capped = false;
            for (const value of values) {
              const facet = { name: SR_FACET_NAME, values: [value] };
              const facetUrl = buildPostingsUrl(slug, 0, facet);
              assertSmartRecruitersUrl(facetUrl);
              const facetJson = await ctx.fetchJson(facetUrl, { redirect: 'error' });
              const reason = facetUsable(facetJson, boardTotal, facet);
              if (reason === 'empty') { perValue[value] = 0; continue; }
              if (reason) { facetFallback = `${value}: ${reason}`; break; }
              const res = await walk(facet, facetJson);
              perValue[value] = res.rows.length;
              if (res.capped) capped = true;
              for (const job of res.rows) {
                const key = job.id || job.url;
                if (key && seenFacet.has(key)) continue;
                if (key) seenFacet.add(key);
                merged.push(job);
              }
            }
            if (!facetFallback && values.length > 0) {
              if (merged.length === 0) facetFallback = 'empty';
              else facetResult = { rows: merged, capped, values, perValue };
            }
          } catch (err) {
            facetFallback = `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
          }
        }
        if (facetResult) {
          all = facetResult.rows;
          if (facetResult.capped) truncated = true;
          keywordSearch = {
            mode: 'facet',
            facet: { name: SR_FACET_NAME, values: facetResult.values },
            terms: facetResult.values.length, boardTotal, perTerm: facetResult.perValue,
          };
        } else {
          all = [];
          const seen = new Set();
          /** @type {Record<string, number>} */
          const perTerm = {};
          for (const term of terms) {
            const { rows, capped } = await walk(term);
            perTerm[term] = rows.length;
            if (capped) truncated = true;
            for (const job of rows) {
              const key = job.id || job.url;
              if (key) {
                if (seen.has(key)) continue;
                seen.add(key);
              }
              all.push(job);
            }
          }
          keywordSearch = { mode: 'keywords', terms: terms.length, boardTotal, perTerm };
          if (facetFallback) keywordSearch.facetFallback = facetFallback;
        }
      }
    } else {
      all = (await walk(null)).rows;
    }

    // Detail enrichment answers "what does this job say", not "is this
    // endpoint alive" — skip it entirely while probing so it never spends
    // budget a liveness check has no use for (same rule as vdab).
    const { fetchDetails, detailLimit } = parseSmartRecruitersConfig(entry);
    const probing = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0;
    if (fetchDetails && !probing) {
      const jobs = all.filter((job) => job.id).slice(0, detailLimit);
      for (let i = 0; i < jobs.length; i += SR_DETAIL_BATCH) {
        const batch = jobs.slice(i, i + SR_DETAIL_BATCH);
        await Promise.all(batch.map(async (job) => {
          try {
            const detailUrl = buildPostingDetailUrl(slug, job.id);
            assertSmartRecruitersUrl(detailUrl);
            const detail = await ctx.fetchJson(detailUrl, { redirect: 'error' });
            const description = extractDescription(detail);
            if (description) job.description = description;
          } catch {
            // Detail fetch is an enrichment only. Keep the listing result.
          }
        }));
      }
    }

    // The numeric posting id drove the detail calls above; it is internal
    // plumbing and must not leak into the pipeline's Job rows (vdab strips
    // its id the same way).
    const out = all.map(({ id, ...job }) => job);
    if (keywordSearch) {
      Object.assign(out, truncated ? { keywordSearch, truncated: true } : { keywordSearch });
    }
    return out;
  },
};

/**
 * Parse a SmartRecruiters /postings response. Exported for unit tests.
 *
 * SmartRecruiters returns:
 *   { content: [{ id, name, ref, location: { fullLocation?, city?, region?, country?, remote? } }] }
 *
 * - location: prefer `fullLocation`; else assemble from city/region/country
 *   parts (skipping empties); append "Remote" when `location.remote` is true.
 * - url: `j.ref` is an `api.smartrecruiters.com/v1/companies/<slug>/postings/<id>`
 *   URL — rewrite to the public `jobs.smartrecruiters.com/<slug>/<id>-<title-slug>`.
 *   The public site has no `/postings/` segment; carrying it over yields a 404,
 *   which the liveness checker then reports as an expired posting (#1612).
 *   SmartRecruiters resolves the page by id alone, so the trailing title slug is
 *   cosmetic. If `ref` is missing or untrusted, synthesise the same shape from
 *   the company slug + posting id.
 *
 * @param {any} json
 * @param {string} companyName
 * @returns {Array<{title: string, url: string, company: string, location: string, id?: string}>}
 */
export function parseSmartRecruitersResponse(json, companyName) {
  const items = json?.content;
  if (!Array.isArray(items)) return [];
  return items.map(j => {
    const loc = j.location || {};
    const fullLocation = loc.fullLocation || [loc.city, loc.region, loc.country].filter(Boolean).join(', ');
    const remote = loc.remote ? 'Remote' : '';
    const location = [fullLocation, remote].filter(Boolean).join(', ');
    const slugified = (j.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    let url = '';
    if (typeof j.ref === 'string') {
      let parsedRef;
      try { parsedRef = new URL(j.ref); } catch { parsedRef = null; }
      if (parsedRef
          && parsedRef.protocol === 'https:'
          && parsedRef.hostname === 'api.smartrecruiters.com'
          && parsedRef.pathname.startsWith('/v1/companies/')) {
        // /v1/companies/<slug>/postings/<id> → <slug>, <id>
        const [refSlug, postings, refId] = parsedRef.pathname
          .slice('/v1/companies/'.length)
          .split('/')
          .filter(Boolean);
        if (refSlug && postings === 'postings' && refId) {
          url = `https://jobs.smartrecruiters.com/${refSlug}/${refId}${slugified ? `-${slugified}` : ''}`;
        }
      }
    }
    if (!url && j.id) {
      const companySlug = (companyName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (companySlug) {
        url = `https://jobs.smartrecruiters.com/${companySlug}/${j.id}${slugified ? `-${slugified}` : ''}`;
      }
    }
    return { title: j.name || '', url, location, company: companyName, id: typeof j.id === 'string' || typeof j.id === 'number' ? String(j.id) : undefined };
  });
}
