// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Eightfold AI provider — hits the public per-tenant Talent Acquisition JSON
// API (zero-auth GET, no token or cookie). Eightfold hosts branded career
// sites for large enterprises (Bayer, Vodafone, PepsiCo, Autodesk, Micron, …).
//
// Host pattern (per-tenant):
//   <tenant>.eightfold.ai        e.g. bayer.eightfold.ai
//
// Career page URL:
//   https://<tenant>.eightfold.ai/careers[?domain=<domain>]
// Many tenants also front the same board on a branded CNAME
// (careers.<company>.com). That host is deliberately NOT accepted: the API is
// host-pinned to *.eightfold.ai, so an entry must point at the canonical
// tenant host. Set `careers_url` (or `api`) to the eightfold.ai form.
//
// JSON API (GET, zero-auth):
//   https://<tenant>.eightfold.ai/api/apply/v2/jobs
//   ?domain=<domain>&start=<n>&num=<n>
//   `domain` is OPTIONAL — the server infers it from the tenant host and
//   echoes it back as `domain` in the response, so omitting it still returns
//   that tenant's board. It is still sent when the entry supplies one,
//   because multi-brand tenants scope their board by it.
//   Response: { positions: [...], count: <total>, domain: "<domain>" }.
//   Per position: id, name, posting_name, location, locations[], department,
//   business_unit, t_create/t_update (epoch SECONDS), canonicalPositionUrl,
//   display_job_id.
//
// PAGE SIZE IS SERVER-CAPPED AT 10. Requesting num=25/50/100/200 all return
// exactly 10 rows (measured against a 616-posting tenant). So a large board
// costs count/10 requests; the page cap below is what keeps that bounded, and
// `max_pages` on the entry raises it for a genuinely huge tenant.
//
// Known limitation: several tenants front the API with a WAF that 403s
// datacenter/cloud egress IPs. That is an environment/IP issue, not a provider
// bug — the same request succeeds from a residential IP. A browser-like
// User-Agent is sent to reduce (not eliminate) the friction.
//
// PCSX fallback (added 2026-11-07). Some tenants (Starbucks, Circana, Corteva,
// Estee Lauder, Whirlpool, Lam Research, Lumen …) answer the v2 API with
// `403 {"message": "Not authorized for PCSX"}` from ANY IP, while the newer
// search endpoint their career site itself uses works zero-auth:
//   https://<tenant>.eightfold.ai/api/pcsx/search
//   ?domain=<domain>&start=<n>&num=<n>[&location=United States][&filter_<k>=<v>…]
//   `domain` is REQUIRED here (422 without it). Response envelope:
//   { status: 200, error: {message, body}, data: { positions: [...], count } }
//   Per position: id, name, locations[], postedTs/creationTs (epoch SECONDS),
//   positionUrl ("/careers/job/<id>"). Page size is again capped at 10.
// Mode selection (`eightfold_mode` on the entry):
//   (unset) → v2 first; on HTTP 403 for the first page, switch to PCSX.
//   "pcsx"  → PCSX only (skips the doomed v2 request).
//   "v2"    → v2 only, no fallback.
// PCSX-only entry keys:
//   location: location filter (default "United States"; "any" = no filter).
//   query:    keyword search (query=<text>) for boards too big to page in full.
//   filters:  { <facet>: value | [values] } → filter_<facet>=<value> (e.g.
//             job_category), to keep a huge board (Starbucks retail) bounded.
// When no domain is known, the tenant's own /careers page (same pinned host)
// is fetched once and its `"domain": "<x>"` config value is used.

import { BROWSER_LIKE_USER_AGENT, fetchJsonWithRetry, fetchTextWithRetry } from './_http.mjs';

const EIGHTFOLD_HOST_RE = /^[a-z0-9-]+\.eightfold\.ai$/i;

// The API refuses to return more than 10 rows per request regardless of `num`.
const PAGE_SIZE = 10;
// Safety cap on pagination, applied regardless of what `count` claims, so a
// misbehaving or compromised API cannot drive an unbounded request loop.
// 200 pages = 2,000 postings; override with `max_pages` on the portal entry.
const DEFAULT_MAX_PAGES = 200;
// Hard ceiling even for an explicit override (10,000 postings).
const MAX_PAGES_CAP = 1000;
// Same-host pacing between pages inside one tenant's own pagination loop.
// Eightfold's edge rate-limits bursts, and a 616-job board is 62 requests.
const INTER_PAGE_DELAY_MS = 250;

const RETRY_POLICY = { retries: 3, baseDelayMs: 500, maxDelayMs: 8_000 };

/**
 * SSRF guard — every request URL passes through here before it is fetched.
 *
 * @param {string} url
 * @returns {string} the same URL, when it is a trusted Eightfold endpoint.
 */
function assertEightfoldUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`eightfold: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`eightfold: URL must use HTTPS: ${url}`);
  if (!EIGHTFOLD_HOST_RE.test(parsed.hostname)) {
    throw new Error(`eightfold: untrusted hostname "${parsed.hostname}" — must match *.eightfold.ai`);
  }
  return url;
}

/** @param {number} ms @param {any} ctx */
function sleep(ms, ctx) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Eightfold reports timestamps as epoch SECONDS (`t_create`, `t_update`), not
 * the ISO strings every other provider gets. Converted here; anything
 * non-finite or non-positive is dropped rather than guessed at.
 *
 * @param {unknown} value
 * @returns {number|undefined} epoch ms, or undefined.
 */
function epochSecondsToMs(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n * 1000);
}

/**
 * Resolve the tenant host from a portal entry. `entry.api` takes precedence
 * over `entry.careers_url` (mirrors greenhouse/ashby/oraclecloud) so a branded
 * careers page can stay as careers_url while the tenant host is pinned via
 * api:. An explicit `entry.domain` overrides any `?domain=` in the URL.
 *
 * @param {import('./_types.js').PortalEntry & {domain?: string}} entry
 * @returns {{host: string, domain: (string|null)}|null}
 */
export function resolveTenant(entry) {
  for (const raw of [entry?.api, entry?.careers_url]) {
    if (typeof raw !== 'string' || !raw) continue;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:') continue;
    if (!EIGHTFOLD_HOST_RE.test(parsed.hostname)) continue;

    const override = typeof entry.domain === 'string' && entry.domain.trim()
      ? entry.domain.trim()
      : null;
    const fromUrl = parsed.searchParams.get('domain');
    const domain = override || (fromUrl && fromUrl.trim() ? fromUrl.trim() : null);
    // Some tenants serve a second board (e.g. a campus site) only under ?microsite=<name>.
    const micrositeRaw = typeof entry.microsite === 'string' && entry.microsite.trim()
      ? entry.microsite.trim()
      : (parsed.searchParams.get('microsite') || '').trim();

    return { host: parsed.hostname.toLowerCase(), domain, ...(micrositeRaw ? { microsite: micrositeRaw } : {}) };
  }
  return null;
}

/**
 * Build the jobs API URL for one page.
 *
 * @param {{host: string, domain?: (string|null)}} tenant
 * @param {number} [start] - Row offset (0-based).
 * @param {number} [num]   - Requested page size; the server caps it at 10.
 * @returns {string}
 */
export function buildApiUrl(tenant, start = 0, num = PAGE_SIZE) {
  const params = new URLSearchParams();
  if (tenant.domain) params.set('domain', tenant.domain);
  if (tenant.microsite) params.set('microsite', tenant.microsite);
  params.set('start', String(start));
  params.set('num', String(num));
  return `https://${tenant.host}/api/apply/v2/jobs?${params.toString()}`;
}

/**
 * Fallback posting URL for a position with no `canonicalPositionUrl`.
 *
 * @param {{host: string, domain?: (string|null)}} tenant
 * @param {string} pid
 * @returns {string}
 */
export function buildJobUrl(tenant, pid) {
  const params = new URLSearchParams();
  params.set('pid', pid);
  if (tenant.domain) params.set('domain', tenant.domain);
  return `https://${tenant.host}/careers?${params.toString()}`;
}

/**
 * Assemble a location string. Prefers the flat `location` field, else joins
 * the `locations[]` array. Deduped, joined with " · " like ashby's
 * secondaryLocations handling so scan.mjs's location_filter sees every city
 * a multi-site role is open to.
 *
 * @param {any} p
 * @returns {string}
 */
function assembleLocation(p) {
  const parts = [];
  if (typeof p.location === 'string' && p.location.trim()) parts.push(p.location.trim());
  if (Array.isArray(p.locations)) {
    for (const loc of p.locations) {
      if (typeof loc === 'string' && loc.trim()) parts.push(loc.trim());
    }
  }
  return [...new Set(parts)].join(' · ');
}

/**
 * Pure normalizer for one `/api/apply/v2/jobs` response. Exported for unit
 * tests. Returns [] for null / {} / non-array / {positions: null}.
 *
 * Drop rules (a dropped row is silently omitted, never emitted half-formed):
 *   - no title (`name`, falling back to `posting_name`)
 *   - no usable https URL — `canonicalPositionUrl` must parse as https:, and
 *     when it is absent/unusable there must be an `id` to build the tenant
 *     fallback URL from. The URL is the dedup key downstream.
 *
 * `canonicalPositionUrl` frequently points at a branded host
 * (talent.bayer.com), not eightfold.ai. That is accepted: these URLs are
 * display-only — written to pipeline/history, never fetched by the scanner —
 * exactly as jobvite.mjs treats its applyURLs. Host-pinning applies to
 * endpoints WE request, not to links we merely record.
 *
 * @param {unknown} json
 * @param {{host: string, domain?: (string|null)}} tenant
 * @param {string} companyName
 * @returns {Array<{title: string, url: string, company: string, location: string, postedAt?: number}>}
 */
export function parseEightfoldResponse(json, tenant, companyName) {
  if (!json || typeof json !== 'object') return [];
  const positions = /** @type {any} */ (json).positions;
  if (!Array.isArray(positions)) return [];

  const out = [];
  for (const p of positions) {
    if (!p || typeof p !== 'object') continue;

    const title = (typeof p.name === 'string' && p.name.trim())
      ? p.name.trim()
      : (typeof p.posting_name === 'string' ? p.posting_name.trim() : '');
    if (!title) continue;

    let url = '';
    const canonical = typeof p.canonicalPositionUrl === 'string' ? p.canonicalPositionUrl.trim() : '';
    if (canonical) {
      try {
        const parsed = new URL(canonical);
        if (parsed.protocol === 'https:') url = parsed.href;
      } catch {
        // malformed — fall through to the tenant fallback
      }
    }
    if (!url) {
      const pid = p.id != null && `${p.id}`.trim() ? `${p.id}`.trim() : '';
      if (pid) url = buildJobUrl(tenant, pid);
    }
    if (!url) continue;

    /** @type {{title: string, url: string, company: string, location: string, postedAt?: number}} */
    const job = {
      title,
      url,
      company: companyName,
      location: assembleLocation(p),
    };
    const postedAt = epochSecondsToMs(p.t_create) ?? epochSecondsToMs(p.t_update);
    if (postedAt !== undefined) job.postedAt = postedAt;

    out.push(job);
  }
  return out;
}

/**
 * Resolve the page cap: a positive integer `max_pages` on the entry, capped
 * at MAX_PAGES_CAP; then narrowed further by ctx.maxPages when the caller is
 * only probing (verify-portals.mjs's health check passes 1).
 *
 * @param {any} entry
 * @param {any} ctx
 * @returns {number}
 */
function resolveMaxPages(entry, ctx) {
  const v = entry?.max_pages;
  const fromEntry = Number.isInteger(v) && v > 0 ? Math.min(v, MAX_PAGES_CAP) : DEFAULT_MAX_PAGES;
  const hint = Number(ctx?.maxPages);
  return Number.isFinite(hint) && hint > 0 ? Math.min(fromEntry, Math.floor(hint)) : fromEntry;
}

/** @type {Provider} */
export default {
  id: 'eightfold',

  detect(entry) {
    try {
      const tenant = resolveTenant(entry);
      return tenant ? { url: buildApiUrl(tenant, 0, PAGE_SIZE) } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const tenant = resolveTenant(entry);
    if (!tenant) throw new Error(`eightfold: cannot derive API URL for ${entry.name}`);

    const mode = resolveMode(entry);
    if (mode === 'pcsx') return fetchPcsx(entry, tenant, ctx);
    try {
      return await fetchV2(entry, tenant, ctx);
    } catch (err) {
      if (mode === 'auto' && /** @type {any} */ (err)?.status === 403 && /** @type {any} */ (err)?.eightfoldFirstPage) {
        return fetchPcsx(entry, tenant, ctx);
      }
      throw err;
    }
  },
};

/**
 * @param {any} entry
 * @returns {'auto'|'pcsx'|'v2'}
 */
export function resolveMode(entry) {
  const raw = entry?.eightfold_mode;
  if (raw === undefined || raw === null || raw === '') return 'auto';
  if (raw === 'pcsx' || raw === 'v2') return raw;
  throw new Error(`eightfold: unknown eightfold_mode ${JSON.stringify(raw)} for ${entry?.name} (use "pcsx" or "v2")`);
}

/**
 * v2 pagination loop (original behaviour). A first-page HTTP error is tagged
 * so fetch() can tell "this tenant refuses v2" from a mid-board failure.
 *
 * @param {any} entry
 * @param {any} tenant
 * @param {any} ctx
 */
async function fetchV2(entry, tenant, ctx) {
  const maxPages = resolveMaxPages(entry, ctx);
  const all = [];
  /** @type {number|null} */
  let total = null;

  for (let page = 0; page < maxPages; page++) {
    const start = page * PAGE_SIZE;
    const apiUrl = buildApiUrl(tenant, start, PAGE_SIZE);
    assertEightfoldUrl(apiUrl); // SSRF guard before every fetch
    if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);

    let json;
    try {
      json = /** @type {any} */ (await fetchJsonWithRetry(
        /** @type {any} */ (ctx),
        apiUrl,
        {
          // redirect:'error' prevents SSRF via a server-side redirect; with
          // assertEightfoldUrl above it guarantees the final hostname stays
          // inside *.eightfold.ai.
          redirect: 'error',
          headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT, Accept: 'application/json' },
        },
        RETRY_POLICY,
      ));
    } catch (err) {
      if (page === 0 && err && typeof err === 'object') /** @type {any} */ (err).eightfoldFirstPage = true;
      throw err;
    }

    all.push(...parseEightfoldResponse(json, tenant, entry.name));

    const positions = Array.isArray(json?.positions) ? json.positions : [];
    if (total === null && typeof json?.count === 'number' && Number.isFinite(json.count)) {
      total = json.count;
    }

    // Stop conditions, in the order they can be trusted:
    //   - an empty or short page is the end of the board;
    //   - once we have paged past `count` there is nothing left to ask for.
    // `count` alone is not enough: it is the pre-filter total on some
    // tenants, so a short page has to win.
    if (positions.length === 0 || positions.length < PAGE_SIZE) break;
    if (total !== null && start + PAGE_SIZE >= total) break;
  }

  if (total !== null && all.length < total && maxPages * PAGE_SIZE < total) {
    console.error(`⚠️  eightfold: ${entry.name} truncated at max_pages=${maxPages} (${all.length} of ${total} jobs) — raise max_pages on this entry for more`);
  }

  return all;
}

// ── PCSX ───────────────────────────────────────────────────────────────

const FILTER_KEY_RE = /^[a-z][a-z0-9_]{0,40}$/;
const MAX_FILTER_VALUES = 40;
// Tenant config embeds the board domain as `"domain": "starbucks.com"` (raw
// JSON in a script tag, or HTML-escaped with &#34; inside an attribute).
const DOMAIN_IN_PAGE_RE = /(?:"|&#34;|&quot;)domain(?:"|&#34;|&quot;)\s*:\s*(?:"|&#34;|&quot;)([a-z0-9.-]+\.[a-z]{2,})(?:"|&#34;|&quot;)/i;

/**
 * Normalize entry.filters into [key, value] pairs. Unknown shapes throw so a
 * YAML typo cannot silently widen the query to the whole board.
 *
 * @param {any} entry
 * @returns {Array<[string, string]>}
 */
export function resolvePcsxFilters(entry) {
  const f = entry?.filters;
  if (f === undefined || f === null) return [];
  if (typeof f !== 'object' || Array.isArray(f)) throw new Error(`eightfold: filters must be a mapping for ${entry?.name}`);
  /** @type {Array<[string, string]>} */
  const out = [];
  for (const [key, raw] of Object.entries(f)) {
    if (!FILTER_KEY_RE.test(key)) throw new Error(`eightfold: invalid filter key ${JSON.stringify(key)} for ${entry?.name}`);
    const values = Array.isArray(raw) ? raw : [raw];
    for (const v of values) {
      if (typeof v !== 'string' || !v.trim()) throw new Error(`eightfold: filter ${key} needs non-empty string values for ${entry?.name}`);
      out.push([key, v.trim()]);
    }
  }
  if (out.length > MAX_FILTER_VALUES) throw new Error(`eightfold: too many filter values (${out.length}) for ${entry?.name}`);
  return out;
}

/**
 * @param {any} entry
 * @returns {string|null} location filter, or null for none.
 */
export function resolvePcsxLocation(entry) {
  const loc = entry?.location;
  if (loc === undefined || loc === null) return 'United States';
  if (typeof loc !== 'string') throw new Error(`eightfold: location must be a string for ${entry?.name}`);
  const t = loc.trim();
  if (!t || t.toLowerCase() === 'any') return null;
  return t;
}

/**
 * Optional keyword search (`query` on the entry). Only for boards too large
 * or too rate-limited to page in full (Microsoft: 1,280 US rows took ~20 min
 * under PCSX throttling, while query=intern returned every intern-titled row
 * of the full board, 42 ≥ 39, measured 2026-11-08).
 *
 * @param {any} entry
 * @returns {string|null}
 */
export function resolvePcsxQuery(entry) {
  const q = entry?.query;
  if (q === undefined || q === null) return null;
  if (typeof q !== 'string' || !q.trim() || q.length > 100) throw new Error(`eightfold: query must be a non-empty string (≤100 chars) for ${entry?.name}`);
  return q.trim();
}

/**
 * @param {{host: string, domain: string}} tenant
 * @param {number} start
 * @param {{location?: (string|null), filters?: Array<[string,string]>, query?: (string|null)}} [opts]
 * @returns {string}
 */
export function buildPcsxUrl(tenant, start = 0, opts = {}) {
  const params = new URLSearchParams();
  params.set('domain', tenant.domain);
  params.set('start', String(start));
  params.set('num', String(PAGE_SIZE));
  if (opts.location) params.set('location', opts.location);
  if (opts.query) params.set('query', opts.query);
  for (const [k, v] of opts.filters || []) params.append(`filter_${k}`, v);
  return `https://${tenant.host}/api/pcsx/search?${params.toString()}`;
}

/**
 * Pull the board domain out of a tenant /careers page.
 * @param {string} html
 * @returns {string|null}
 */
export function extractDomainFromPage(html) {
  if (typeof html !== 'string') return null;
  const m = DOMAIN_IN_PAGE_RE.exec(html);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Strict parser for one PCSX response. Throws on an error envelope or an
 * unexpected shape; skips individual malformed positions.
 *
 * @param {unknown} json
 * @param {{host: string, domain: string}} tenant
 * @param {string} companyName
 * @returns {{jobs: Array<{title: string, url: string, company: string, location: string, postedAt?: number}>, rawCount: number, total: (number|null)}}
 */
export function parsePcsxResponse(json, tenant, companyName) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(`eightfold pcsx: ${companyName}: response is not a JSON object`);
  }
  const j = /** @type {any} */ (json);
  if (j.status !== undefined && j.status !== 200) {
    throw new Error(`eightfold pcsx: ${companyName}: envelope status ${JSON.stringify(j.status)} ${JSON.stringify(j.error?.message ?? j.message ?? '')}`.trim());
  }
  const errMsg = j.error && typeof j.error === 'object' ? j.error.message : j.error;
  if (typeof errMsg === 'string' && errMsg.trim()) {
    throw new Error(`eightfold pcsx: ${companyName}: error envelope: ${errMsg.trim()}`);
  }
  if (j.messages && typeof j.messages === 'object') {
    throw new Error(`eightfold pcsx: ${companyName}: request rejected: ${JSON.stringify(j.messages).slice(0, 200)}`);
  }
  const data = j.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`eightfold pcsx: ${companyName}: response has no data object`);
  }
  if (!Array.isArray(data.positions)) {
    throw new Error(`eightfold pcsx: ${companyName}: data.positions is not an array`);
  }
  const total = typeof data.count === 'number' && Number.isFinite(data.count) ? data.count : null;

  const jobs = [];
  for (const p of data.positions) {
    if (!p || typeof p !== 'object') continue;
    const title = typeof p.name === 'string' ? p.name.trim() : '';
    if (!title) continue;
    const id = (typeof p.id === 'number' && Number.isFinite(p.id)) || (typeof p.id === 'string' && /^[A-Za-z0-9_-]+$/.test(p.id.trim()))
      ? String(p.id).trim()
      : '';

    let url = '';
    if (typeof p.positionUrl === 'string' && p.positionUrl.startsWith('/') && !p.positionUrl.startsWith('//')) {
      try {
        const u = new URL(p.positionUrl, `https://${tenant.host}`);
        if (u.hostname === tenant.host) {
          if (!u.searchParams.has('domain')) u.searchParams.set('domain', tenant.domain);
          url = u.href;
        }
      } catch { /* fall through */ }
    }
    if (!url && id) url = `https://${tenant.host}/careers/job/${encodeURIComponent(id)}?domain=${encodeURIComponent(tenant.domain)}`;
    if (!url) continue;

    const locs = [];
    if (Array.isArray(p.locations)) {
      for (const l of p.locations) if (typeof l === 'string' && l.trim()) locs.push(l.trim());
    } else if (typeof p.location === 'string' && p.location.trim()) {
      locs.push(p.location.trim());
    }

    /** @type {{id?: string, title: string, url: string, company: string, location: string, postedAt?: number}} */
    const job = { title, url, company: companyName, location: [...new Set(locs)].join(' · ') };
    if (id) job.id = id;
    const postedAt = (typeof p.postedTs === 'number' ? epochSecondsToMs(p.postedTs) : undefined)
      ?? (typeof p.creationTs === 'number' ? epochSecondsToMs(p.creationTs) : undefined);
    if (postedAt !== undefined) job.postedAt = postedAt;
    jobs.push(job);
  }
  return { jobs, rawCount: data.positions.length, total };
}

/**
 * @param {any} entry
 * @param {{host: string, domain: (string|null)}} tenant
 * @param {any} ctx
 */
async function resolvePcsxDomain(entry, tenant, ctx) {
  if (tenant.domain) return tenant.domain;
  const pageUrl = assertEightfoldUrl(`https://${tenant.host}/careers`);
  const html = await fetchTextWithRetry(
    /** @type {any} */ (ctx),
    pageUrl,
    { redirect: 'error', headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT, Accept: 'text/html' } },
    RETRY_POLICY,
  );
  const domain = extractDomainFromPage(html);
  if (!domain) throw new Error(`eightfold pcsx: ${entry.name}: no domain on ${pageUrl}; add ?domain=<domain> to careers_url`);
  return domain;
}


// PCSX rate limiting (measured 2026-11-08 on qualcomm/microsoft): about eight
// requests in a burst, then 429 for ~20 s. The generic retry (sub-10 s
// backoff) gives up inside that window, so a 429 that survives it gets a
// cooldown of RATE_LIMIT_COOLDOWN_MS × attempt, and the page delay for the
// rest of this board is raised (doubling, capped) so the loop settles under
// the limit instead of hammering it. Bounded: RATE_LIMIT_RETRIES cooldowns,
// then the 429 is rethrown.
export const RATE_LIMIT_COOLDOWN_MS = 15_000;
export const RATE_LIMIT_RETRIES = 4;
const MAX_ADAPTIVE_DELAY_MS = 4_000;
const PCSX_RETRY_POLICY = { retries: 2, baseDelayMs: 1_000, maxDelayMs: 8_000 };

/**
 * @param {any} ctx
 * @param {string} apiUrl
 * @param {{delayMs: number}} pacing - mutated: raised after a 429.
 */
async function fetchPcsxPage(ctx, apiUrl, pacing) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchJsonWithRetry(
        /** @type {any} */ (ctx),
        apiUrl,
        { redirect: 'error', headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT, Accept: 'application/json' } },
        PCSX_RETRY_POLICY,
      );
    } catch (err) {
      if (/** @type {any} */ (err)?.status !== 429 || attempt > RATE_LIMIT_RETRIES) throw err;
      pacing.delayMs = Math.min(Math.max(pacing.delayMs * 2, 1_000), MAX_ADAPTIVE_DELAY_MS);
      await sleep(RATE_LIMIT_COOLDOWN_MS * attempt, ctx);
    }
  }
}

/**
 * @param {any} entry
 * @param {{host: string, domain: (string|null)}} tenantIn
 * @param {any} ctx
 */
async function fetchPcsx(entry, tenantIn, ctx) {
  const location = resolvePcsxLocation(entry);
  const query = resolvePcsxQuery(entry);
  const filters = resolvePcsxFilters(entry);
  const domain = await resolvePcsxDomain(entry, tenantIn, ctx);
  const tenant = { host: tenantIn.host, domain };
  const maxPages = resolveMaxPages(entry, ctx);
  const all = [];
  /** @type {number|null} */
  let total = null;
  const pacing = { delayMs: INTER_PAGE_DELAY_MS };

  for (let page = 0; page < maxPages; page++) {
    const start = page * PAGE_SIZE;
    const apiUrl = assertEightfoldUrl(buildPcsxUrl(tenant, start, { location, filters, query }));
    if (page > 0) await sleep(pacing.delayMs, ctx);
    const json = await fetchPcsxPage(ctx, apiUrl, pacing);
    const { jobs, rawCount, total: t } = parsePcsxResponse(json, tenant, entry.name);
    all.push(...jobs);
    if (total === null && t !== null) total = t;
    if (rawCount === 0 || rawCount < PAGE_SIZE) break;
    if (total !== null && start + PAGE_SIZE >= total) break;
  }

  if (total !== null && all.length < total && maxPages * PAGE_SIZE < total) {
    console.error(`⚠️  eightfold: ${entry.name} truncated at max_pages=${maxPages} (${all.length} of ${total} jobs) — raise max_pages or narrow filters`);
  }
  return all;
}
