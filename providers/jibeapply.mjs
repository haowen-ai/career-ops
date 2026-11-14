// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { safeEncodeURIComponent } from './_safe-url.mjs';

// JibeApply provider — hits the /api/jobs endpoint on the same hostname.
// Auto-detects from careers_url pattern `https://<slug>.jibeapply.com`.
// iCIMS acquired Jibe in 2019; some tenants run it on a branded custom
// domain instead. The JSON API at /api/jobs is stable across all tenants.

// Safety cap on pagination — applied regardless of what the upstream reports
// as totalCount, so a misbehaving/compromised API can't drive this into
// fetching thousands of pages. Every known real tenant (10/page) stays well
// under the default of 50 pages (500 jobs); override with `max_pages` on the
// portal entry for a tenant that genuinely exceeds it — each page is a
// sequential round-trip, so raising the default for everyone isn't free.
const DEFAULT_MAX_PAGES = 50;
// Hard ceiling on an entry's own max_pages: 5000 pages (50,000 jobs at 10/page) is above
// every real tenant observed (Costco ~2,100 pages) yet still bounds an absurd override.
const MAX_PAGES_CAP = 5000;

// Fallback page size when a response carries no jobs and no usable `count`
// (e.g. an empty first page). Confirmed live against real tenants — JibeApply
// reports this as `filter.displayLimit` and it has been 10 on every tenant
// observed so far.
const DEFAULT_PAGE_SIZE = 10;

// Opt-in per entry: `page_size: N` sends `limit=N` so each request returns up to N
// postings (measured on careers.petsmart.com: limit=100 returns 100 and `page` then
// counts in those units). Fewer, larger requests reach more of a big board for the
// same politeness (robots.txt there is `Allow: /`, crawl-delay 5). Default is
// unchanged: no `limit` is sent unless the entry sets it.
const MAX_PAGE_SIZE = 100;

/** Resolve an explicit page size: a positive integer `page_size`, capped; null = not set. */
function resolvePageSize(entry) {
  const v = entry?.page_size;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGE_SIZE);
  return null;
}

/** Resolve the page cap: a positive integer `max_pages` on the entry, capped. */
function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

function toApiUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (!/^[a-z0-9-]+\.jibeapply\.com$/i.test(u.hostname)) return null;
  if (!u.pathname.startsWith('/api/')) {
    u.pathname = '/api' + (u.pathname.startsWith('/') ? u.pathname : '/' + u.pathname);
  }
  return u.href;
}

// Validate an explicit entry.api URL (any HTTPS hostname — used for iCIMS-hosted,
// branded JibeApply sites that share the same JSON schema).
function validateExplicitApi(apiUrl) {
  let u;
  try { u = new URL(apiUrl); } catch { return null; }
  return u.protocol === 'https:' ? u.href : null;
}

export function parseJibeapplyResponse(json, entry) {
  let origin = '';
  try { origin = new URL(entry.careers_url || '').origin; } catch { /* ignore */ }
  // careers_url isn't required to be a well-formed absolute URL for fetch()
  // to succeed (an explicit entry.api bypasses it entirely — see toApiUrl
  // callers below) — fall back to api's origin so job URLs stay absolute
  // instead of silently degrading to a relative "/jobs/<slug>" path.
  if (!origin) {
    try { origin = new URL(entry.api || '').origin; } catch { /* ignore */ }
  }
  const items = Array.isArray(json?.jobs) ? json.jobs : [];
  return items
    .map(item => {
      if (item == null) return null;
      const d = item.data ?? item;
      const title = String(d.title || '').trim();
      const slug = d.slug || d.req_id;
      if (!title || !slug) return null;
      // A lone surrogate in slug throws URIError out of encodeURIComponent and
      // aborts the whole page's .map(); drop just this job (the trailing
      // .filter(Boolean) removes the null).
      const encodedSlug = safeEncodeURIComponent(slug);
      if (encodedSlug === null) return null;
      return {
        title,
        url: `${origin}/jobs/${encodedSlug}`,
        company: String(d.hiring_organization || entry.name || '').trim(),
        location: d.full_location || [d.city, d.country].filter(Boolean).join(', '),
      };
    })
    .filter(Boolean);
}

/** @type {Provider} */
export default {
  id: 'jibeapply',

  detect(entry) {
    const url = entry.careers_url;
    if (typeof url !== 'string') return null;
    const apiUrl = toApiUrl(url);
    if (!apiUrl) return null;
    return { url: apiUrl };
  },

  async fetch(entry, ctx) {
    const url = entry.careers_url;
    if (typeof url !== 'string' || !url) throw new Error('jibeapply: careers_url required');

    // Prefer an explicit entry.api (allows iCIMS-hosted, branded JibeApply sites
    // that share the same JSON schema but aren't on jibeapply.com).
    const apiUrl = (typeof entry.api === 'string' && validateExplicitApi(entry.api))
      || toApiUrl(url);
    if (!apiUrl) throw new Error(`jibeapply: cannot derive API URL for ${entry.name}`);
    // Opt-in page_size (upstream #6692): more postings per request.
    const requestedSize = resolvePageSize(entry);
    let firstUrl = apiUrl;
    if (requestedSize) {
      const u1 = new URL(apiUrl);
      u1.searchParams.set('limit', String(requestedSize));
      firstUrl = u1.toString();
    }
    const first = await ctx.fetchJson(firstUrl, { redirect: 'error' });

    // Keyword search (entry.keywords / entry.keyword_min_total, filled in by
    // the caller): a big board is read through the site's own search instead
    // of paging every posting. Verified live 2026-11-09: the JibeApply search
    // parameter is `keywords=` (plural) — `keyword=` and `q=` are ignored and
    // return the full board.
    const terms = normalizeKeywords(entry.keywords);
    if (terms.length > 0) {
      const boardTotal = typeof first?.totalCount === 'number' && Number.isFinite(first.totalCount)
        ? first.totalCount : null;
      const minTotal = entry.keyword_min_total;
      const hasMin = Number.isInteger(minTotal) && minTotal > 0;
      if (!hasMin || boardTotal === null || boardTotal > minTotal) {
        // The site's own tags come first: when the first response offers a
        // facet value for student roles (e.g. Ulta tags1=Internship,
        // categories=Internships), read that filter instead of searching.
        if (entry.facet !== false) {
          const viaFacet = await facetSearch(entry, ctx, firstUrl, first, boardTotal);
          if (viaFacet) return viaFacet;
        }
        return keywordSearch(entry, ctx, firstUrl, terms, boardTotal);
      }
    }

    const { jobs: allJobs, truncated } = await paginate(entry, ctx, firstUrl, first, '');
    const result = parseJibeapplyResponse({ jobs: allJobs }, entry);
    // Set when the board is cut short (page cap or a failed page), so a caller can tell a
    // partial board from a complete one without reading stderr (upstream #5327).
    if (truncated) /** @type {any} */ (result).jibeapplyTruncated = true;
    return result;
  },
};

/** Trimmed, non-empty, de-duplicated string terms; [] when keywords is absent/false/empty. */
function normalizeKeywords(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const term = t.trim();
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

/**
 * Page through /api/jobs starting from an already-fetched first page.
 * `label` only decorates log lines (e.g. ` keywords="intern"`).
 * Returns the raw job items plus whether the max_pages cap cut it short.
 */
async function paginate(entry, ctx, baseUrl, first, label) {
  const total = first?.totalCount ?? 0;
  // Use the actual number of items returned as page size — some implementations
  // set `count` to the total rather than the per-page count.
  const pageSize = first?.jobs?.length || first?.count || DEFAULT_PAGE_SIZE;
  const allJobs = [...(first?.jobs ?? [])];
  let truncated = false;
  let pageFailed = false;

  if (total > pageSize && pageSize > 0) {
    // A health probe (verify-portals passes ctx.maxPages) caps the walk too.
    const probeMax = Number(ctx.maxPages) > 0 ? Number(ctx.maxPages) : Infinity;
    const maxPages = Math.min(resolveMaxPages(entry), probeMax);
    const pages = Math.min(Math.ceil(total / pageSize), maxPages);
    // Sequential, not concurrent (mirrors providers/4dayweek.mjs, thehub.mjs,
    // arbeitnow.mjs, workday.mjs) — a single tenant's API has no reason to
    // receive a burst of parallel requests, and a mid-run failure stops
    // cleanly with whatever pages were already gathered instead of
    // discarding them (Promise.all would fail the whole batch on one error).
    for (let page = 2; page <= pages; page++) {
      const u2 = new URL(baseUrl);
      u2.searchParams.set('page', String(page));
      let json;
      try {
        json = await ctx.fetchJson(u2.toString(), { redirect: 'error' });
      } catch (err) {
        // A health probe (ctx.maxPages set) must see the failure, not first-page jobs as success.
        if (ctx.maxPages != null) throw err;
        pageFailed = true;
        truncated = true;
        console.error(`⚠️  jibeapply: ${entry.name}${label} page ${page} fetch failed — ${err.message} (returning ${allJobs.length} jobs fetched so far)`);
        break;
      }
      allJobs.push(...(json.jobs ?? []));
    }

    // The cap is silent by design (it's a safety net, not a working limit),
    // but a tenant that actually exceeds it needs to be surfaced —
    // otherwise the user has no way to notice postings are missing from
    // their scan. Not when a page failed: that stop is already reported above.
    if (!pageFailed && probeMax === Infinity && Math.ceil(total / pageSize) > maxPages) {
      truncated = true;
      if (maxPages >= MAX_PAGES_CAP) {
        // Raising max_pages cannot help here: the provider ceiling is the limit.
        const hint = pageSize < MAX_PAGE_SIZE
          ? ` — set page_size (up to ${MAX_PAGE_SIZE}) on this portal entry to read more postings per request`
          : ` — narrow the board with a filter in the entry's api URL (e.g. a location query)`;
        console.error(
          `⚠️  jibeapply: ${entry.name}${label} is still cut short at the provider ceiling of ${MAX_PAGES_CAP} pages ` +
          `(fetched ${allJobs.length} of ${total}); max_pages is already at its cap, so raising it changes nothing${hint}`,
        );
      } else {
        console.error(
          `⚠️  jibeapply: ${entry.name}${label} has more postings than max_pages allows ` +
          `(fetched ${allJobs.length} of ${total}) — ` +
          `set max_pages on this portal entry to raise the cap (current: ${maxPages})`,
        );
      }
    }
  }

  return { jobs: allJobs, truncated };
}

/** One paginated `keywords=<term>` query per term, merged and de-duplicated by job id. */
async function keywordSearch(entry, ctx, apiUrl, terms, boardTotal) {
  const merged = [];
  const seen = new Set();
  const perTerm = {};
  let truncated = false;
  let partial = false;

  for (const term of terms) {
    const termUrl = new URL(apiUrl);
    termUrl.searchParams.set('keywords', term);
    termUrl.searchParams.delete('page');
    const label = ` keywords=${JSON.stringify(term)}`;
    let first;
    try {
      first = await ctx.fetchJson(termUrl.toString(), { redirect: 'error' });
    } catch (err) {
      console.error(`⚠️  jibeapply: ${entry.name}${label} fetch failed — ${err.message} (skipping this term)`);
      partial = true;
      perTerm[term] = 0;
      continue;
    }
    const res = await paginate(entry, ctx, termUrl.toString(), first, label);
    if (res.truncated) truncated = true;
    const parsed = [];
    for (const item of res.jobs) {
      const one = parseJibeapplyResponse({ jobs: [item] }, entry)[0];
      if (!one) continue;
      const d = item?.data ?? item;
      parsed.push({ key: String(d?.slug || d?.req_id || one.url), job: one });
    }
    perTerm[term] = parsed.length;
    for (const { key, job } of parsed) {
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(job);
    }
  }

  /** @type {any} */
  const jobs = merged;
  jobs.keywordSearch = { mode: 'keywords', terms: terms.length, boardTotal, perTerm };
  if (truncated) jobs.truncated = true;
  if (partial) jobs.partial = true;
  return jobs;
}


// Student/early-career facet values: plain words (user decision 2026-11-09).
// Each word matches whole-word, case-insensitively, with an optional plural
// or possessive suffix ("Internships", "Master's"). Never a regular expression:
// a configured entry.facet_values is an array of such words and is escaped.
const DEFAULT_FACET_VALUES = [
  'intern', 'internship', 'co-op', 'coop', 'student', 'contract', 'master', 'graduate',
  'early career', 'early talent', 'campus', 'university', 'apprentice',
];
// Facets whose name says they hold places, stores, titles, brands or
// department codes — never role types ("University Hills" store, "Master
// Electrician" title). JibeApply facets carry only a name (tags1, categories),
// no separate label, so the name is all there is to check.
const EXCLUDED_FACET_RE = /store|title|location|city|state|country|region|zip|postal|brand|department|dept|code/i;
// Facets whose name says they classify the role; preferred over the rest.
const PREFERRED_FACET_RE = /employment|job[\s_-]*type|type|categor|experience|level|schedule|tags?\d*$/i;
// A facet with more distinct values than this is a list of titles/stores, not a tag.
const MAX_FACET_VALUES = 200;
// Only the first MAX_VALUE_CHARS characters of a facet value are matched.
const MAX_VALUE_CHARS = 200;
// Longest accepted configured word; longer entries are ignored.
const MAX_WORD_CHARS = 100;

const INTERNAL_WORDS_RE = /\b(?:internal|international)\w*/gi;

/**
 * Build the facet-value matcher from plain words: each word is regex-escaped,
 * runs of whitespace match any whitespace, an optional s / 's suffix is allowed,
 * and the whole word must stand alone (no letter, digit or underscore on either
 * side). Case-insensitive. Exported for tests.
 */
export function buildFacetMatcher(words) {
  const parts = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
  return new RegExp(`(?<!\\w)(?:${parts.join('|')})(?:s|'s|’s)?(?!\\w)`, 'i');
}

const DEFAULT_FACET_MATCHER = buildFacetMatcher(DEFAULT_FACET_VALUES);

/**
 * Whether a facet value is a student-role value under `matcher`. Only the
 * first MAX_VALUE_CHARS characters count. The value must match, and must still
 * match once the words internal/international are removed — so a value whose
 * only hit is one of those words ("International" under "intern", or
 * "Internal" with facet_values ["internal"]) is never sent.
 */
function isStudentValue(term, matcher) {
  const v = term.slice(0, MAX_VALUE_CHARS);
  if (!matcher.test(v)) return false;
  return matcher.test(v.replace(INTERNAL_WORDS_RE, ' '));
}

/**
 * Matcher for facet values: entry.facet_values (an array of plain words or
 * phrases, passed from portals.yml keyword_search.facet_values) or the
 * built-in DEFAULT_FACET_VALUES when absent, empty or not an array.
 */
function resolveFacetMatcher(entry) {
  const raw = entry?.facet_values;
  if (!Array.isArray(raw)) return DEFAULT_FACET_MATCHER;
  const words = [];
  const seen = new Set();
  for (const w of raw) {
    if (typeof w !== 'string') continue;
    const word = w.trim();
    if (!word || word.length > MAX_WORD_CHARS || seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    words.push(word);
  }
  return words.length ? buildFacetMatcher(words) : DEFAULT_FACET_MATCHER;
}

/**
 * Read the facet lists of a /api/jobs response and pick the facet that tags
 * student roles. Sources: `filter.facetList.<name>` ([{term,count}], passed back
 * as `<name>=`) and `filter.categories.all` ([{category,numJobs}], passed as
 * `categories=`). Facets named like stores/titles/places/brands/department codes
 * are skipped; among the rest, facets named like a role classification
 * (employment/job type, category, experience, tagsN) win, then the fewest
 * distinct values.
 * Returns { name, values } or null.
 */
export function findStudentFacet(json, matcher = DEFAULT_FACET_MATCHER) {
  const f = json?.filter;
  if (!f || typeof f !== 'object') return null;
  const candidates = [];
  if (f.facetList && typeof f.facetList === 'object') {
    for (const [name, list] of Object.entries(f.facetList)) {
      if (!Array.isArray(list)) continue;
      candidates.push({ name, list: list.map(v => ({ term: v?.term, count: v?.count })) });
    }
  }
  if (Array.isArray(f.categories?.all)) {
    candidates.push({ name: 'categories', list: f.categories.all.map(v => ({ term: v?.category, count: v?.numJobs })) });
  }
  let best = null;
  for (const c of candidates) {
    if (EXCLUDED_FACET_RE.test(c.name) || c.list.length === 0 || c.list.length > MAX_FACET_VALUES) continue;
    const values = c.list
      .filter(v => typeof v.term === 'string' && v.term.trim() && !v.term.includes('|')
        && !(typeof v.count === 'number' && v.count <= 0) && isStudentValue(v.term, matcher))
      .map(v => v.term);
    if (values.length === 0) continue;
    const rank = PREFERRED_FACET_RE.test(c.name) ? 0 : 1;
    if (!best || rank < best.rank || (rank === best.rank && c.list.length < best.size)) {
      best = { name: c.name, values, size: c.list.length, rank };
    }
  }
  return best ? { name: best.name, values: best.values } : null;
}

/**
 * Fetch the board filtered by the student facet (values OR-ed with "|",
 * verified live: `tags1=Internship|Seasonal` returns the sum of both).
 * Returns the marked job array, or null when there is no matching facet,
 * the request fails, or the filter yields nothing — the caller then falls
 * back to keyword search.
 */
async function facetSearch(entry, ctx, apiUrl, first, boardTotal) {
  const facet = findStudentFacet(first, resolveFacetMatcher(entry));
  if (!facet) return null;
  const u = new URL(apiUrl);
  u.searchParams.set(facet.name, facet.values.join('|'));
  u.searchParams.delete('page');
  const label = ` ${facet.name}=${JSON.stringify(facet.values.join('|'))}`;
  let firstPage;
  try {
    firstPage = await ctx.fetchJson(u.toString(), { redirect: 'error' });
  } catch (err) {
    console.error(`⚠️  jibeapply: ${entry.name}${label} fetch failed — ${err.message} (falling back to keyword search)`);
    return null;
  }
  if (!Array.isArray(firstPage?.jobs) || firstPage.jobs.length === 0) return null;
  const res = await paginate(entry, ctx, u.toString(), firstPage, label);
  const merged = [];
  const seen = new Set();
  for (const item of res.jobs) {
    const one = parseJibeapplyResponse({ jobs: [item] }, entry)[0];
    if (!one) continue;
    const d = item?.data ?? item;
    const key = String(d?.slug || d?.req_id || one.url);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(one);
  }
  if (merged.length === 0) return null;
  /** @type {any} */
  const jobs = merged;
  jobs.keywordSearch = { mode: 'facet', facet, terms: 0, boardTotal, perTerm: {} };
  if (res.truncated) jobs.truncated = true;
  return jobs;
}
