// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchJsonWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

// Dayforce (Ceridian) candidate-portal provider (→ tracked_companies:).
//
// careers_url shape: https://jobs.dayforcehcm.com/{locale?}/{clientNamespace}/{careerSiteXRefCode}
//   e.g. https://jobs.dayforcehcm.com/en-US/ibgllc/CANDIDATEPORTAL
//
// The portal is a Next.js app. Verified live 2026-11-07 by reading its
// page bundle and replaying the calls:
//
//   1. GET  https://jobs.dayforcehcm.com/api/auth/csrf
//      → {"csrfToken":"…"} + Set-Cookie __Host-next-auth.csrf-token=…
//      (next-auth's anonymous CSRF double-submit; every visitor's browser does
//      this — no login, no account.)
//   2. POST https://jobs.dayforcehcm.com/api/geo/{ns}/jobposting/search
//      headers: X-CSRF-TOKEN: <csrfToken>, Cookie: <cookies from step 1>
//      body:    {"clientNamespace":ns,"jobBoardCode":site,"cultureCode":"en-US",
//                "distanceUnit":0,"paginationStart":<0-based row offset>}
//      → {"jobPostings":[{"jobPostingId":2832,"jobTitle":"…",
//           "postingStartTimestampUTC":"2026-11-06T11:00:00+00:00",
//           "postingLocations":[{"formattedAddress":"Greenwich, CT, USA",
//              "isoCountryCode":"US",…}],…}],
//         "maxCount":186,"offset":0,"count":25}
//      Without the CSRF header/cookie the API answers 403. Page size is fixed
//      server-side at 25.
//   Posting page: https://jobs.dayforcehcm.com/{locale}/{ns}/{site}/jobs/{jobPostingId}
//
// Country filter: the API only filters by an internal locationId, so a
// country is applied client-side on postingLocations[].isoCountryCode. Set it
// with `country: US` on the entry or `?country=US` on careers_url (entry key
// wins). A posting is kept if ANY of its locations matches; its location
// string then lists only the matching locations.
//
// Host pinned to jobs.dayforcehcm.com; both API calls go to that same origin,
// so the replayed cookies never leave it.

const ALLOWED_HOSTS = new Set(['jobs.dayforcehcm.com']);
const ORIGIN = 'https://jobs.dayforcehcm.com';
const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LOCALE_RE = /^[a-z]{2}(?:-[A-Za-z0-9]{2,4})?$/;
const PAGE_SIZE = 25; // fixed by the server
const DEFAULT_MAX_PAGES = 40; // 1,000 postings
const MAX_PAGES_CAP = 200;
const INTER_PAGE_DELAY_MS = 200;
const TIMEOUT_MS = 30_000; // pages carry full descriptions

/**
 * Validate careers_url and derive {ns, site, locale, country}.
 * Throws on malformed URL, non-https, foreign host, or an unknown path shape.
 * @param {any} entry
 */
export function resolveConfig(entry) {
  const raw = entry?.careers_url || entry?.api;
  if (typeof raw !== 'string' || !raw) throw new Error('dayforce: careers_url is required');
  const u = new URL(raw); // throws on malformed input
  if (u.protocol !== 'https:') throw new Error(`dayforce: refusing non-https URL ${u.protocol}`);
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) throw new Error(`dayforce: host not allowed: ${u.hostname}`);
  const parts = u.pathname.split('/').filter(Boolean);
  let locale = 'en-US';
  if (parts.length && LOCALE_RE.test(parts[0])) locale = /** @type {string} */ (parts.shift());
  const [ns, site] = parts;
  if (!ns || !site || !SLUG_RE.test(ns) || !SLUG_RE.test(site)) {
    throw new Error(`dayforce: cannot read clientNamespace/careerSite from ${u.pathname}`);
  }
  const rawCountry = typeof entry?.country === 'string' ? entry.country : u.searchParams.get('country');
  const country = typeof rawCountry === 'string' && /^[A-Za-z]{2}$/.test(rawCountry.trim()) ? rawCountry.trim().toUpperCase() : null;
  return { ns, site, locale, country };
}

/** @param {unknown} v */
export function toEpochMs(v) {
  if (!v || typeof v !== 'string') return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms;
}

/** @param {unknown} s */
function clean(s) {
  return typeof s === 'string' ? decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
}

/** Build a Cookie header from Set-Cookie values (name=value pairs only). @param {unknown} setCookies */
export function cookieHeaderFrom(setCookies) {
  const jar = new Map();
  for (const raw of Array.isArray(setCookies) ? setCookies : []) {
    if (typeof raw !== 'string') continue;
    const pair = raw.split(';', 1)[0].trim();
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Parse one search page. Throws on anything that is not {jobPostings: [...]}.
 * @param {any} json
 * @param {{ns:string, site:string, locale:string, country:string|null}} cfg
 */
export function parseSearchResponse(json, cfg) {
  if (json == null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(`dayforce: unexpected search response (${Array.isArray(json) ? 'array' : typeof json})`);
  }
  if (!Array.isArray(json.jobPostings)) {
    const keys = Object.keys(json);
    const detail = typeof json.title === 'string' ? ` — ${json.title}` : '';
    throw new Error(`dayforce: unexpected search response shape (keys: ${keys.slice(0, 8).join(', ') || 'none'})${detail}`);
  }
  const list = json.jobPostings;
  const total = Number.isInteger(json.maxCount) && json.maxCount >= 0 ? json.maxCount : null;
  const rows = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = item.jobPostingId;
    if (!(typeof id === 'number' && Number.isSafeInteger(id) && id > 0) && !(typeof id === 'string' && /^\d{1,12}$/.test(id))) continue;
    const title = clean(item.jobTitle);
    if (!title) continue;
    const locs = Array.isArray(item.postingLocations) ? item.postingLocations.filter((l) => l && typeof l === 'object') : [];
    let picked = locs;
    if (cfg.country) {
      picked = locs.filter((l) => typeof l.isoCountryCode === 'string' && l.isoCountryCode.toUpperCase() === cfg.country);
      if (picked.length === 0) continue;
    }
    const names = [];
    for (const l of picked) {
      const n = clean(l.formattedAddress) || [clean(l.cityName), clean(l.stateCode), clean(l.isoCountryCode)].filter(Boolean).join(', ');
      if (n && !names.includes(n)) names.push(n);
    }
    if (item.hasVirtualLocation === true && !names.length) names.push('Remote');
    rows.push({
      id: String(id),
      title,
      url: `${ORIGIN}/${cfg.locale}/${cfg.ns}/${cfg.site}/jobs/${id}`,
      location: names.join(' / '),
      postedAt: toEpochMs(item.postingStartTimestampUTC),
    });
  }
  return { rows, rawCount: list.length, total };
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

/**
 * Anonymous next-auth CSRF bootstrap → {token, cookie}.
 * @param {any} ctx
 */
async function bootstrapCsrf(ctx) {
  if (typeof ctx?.fetchResponse !== 'function') throw new Error('dayforce: ctx.fetchResponse is required (CSRF cookie)');
  const res = await ctx.fetchResponse(`${ORIGIN}/api/auth/csrf`, { redirect: 'error', headers: { accept: 'application/json' } });
  const setCookies = typeof res?.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error('dayforce: CSRF bootstrap did not return JSON');
  }
  const token = body && typeof body.csrfToken === 'string' && /^[A-Za-z0-9]{16,256}$/.test(body.csrfToken) ? body.csrfToken : '';
  if (!token) throw new Error('dayforce: CSRF bootstrap returned no csrfToken');
  const cookie = cookieHeaderFrom(setCookies);
  if (!/next-auth\.csrf-token=/.test(cookie)) throw new Error('dayforce: CSRF bootstrap set no next-auth.csrf-token cookie');
  return { token, cookie };
}

/** @type {Provider} */
export default {
  id: 'dayforce',

  detect(entry) {
    try {
      const raw = entry?.careers_url || entry?.api;
      if (typeof raw !== 'string') return null;
      resolveConfig({ careers_url: raw });
      return { url: raw };
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry); // throws before any request on a bad host/path
    const { token, cookie } = await bootstrapCsrf(ctx);
    const searchUrl = `${ORIGIN}/api/geo/${cfg.ns}/jobposting/search`;

    const ctxMaxPages = Number(ctx?.maxPages);
    const probing = ctxMaxPages > 0;
    const pagesToFetch = Math.min(resolveMaxPages(entry), probing ? ctxMaxPages : Infinity);

    const jobs = [];
    const seen = new Set();
    let total = null;
    let stopReason = 'end';
    for (let page = 0; page < pagesToFetch; page++) {
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const body = JSON.stringify({
        clientNamespace: cfg.ns,
        jobBoardCode: cfg.site,
        cultureCode: cfg.locale,
        distanceUnit: 0,
        paginationStart: page * PAGE_SIZE,
      });
      let json;
      try {
        json = await fetchJsonWithRetry(ctx, searchUrl, {
          method: 'POST',
          body,
          redirect: 'error',
          timeoutMs: TIMEOUT_MS,
          headers: { accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': token, cookie },
        });
      } catch (err) {
        if (probing || page === 0) throw err; // unwrapped for the probe budget
        throw new Error(`dayforce: ${entry?.name} page ${page + 1} failed (${err?.message}) after ${jobs.length} postings`);
      }
      const parsed = parseSearchResponse(json, cfg);
      if (total === null && parsed.total !== null) total = parsed.total;
      if (parsed.rawCount === 0) break;
      for (const row of parsed.rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        const job = { title: row.title, url: row.url, company: entry.name, location: row.location };
        if (typeof row.postedAt === 'number') job.postedAt = row.postedAt;
        jobs.push(job);
      }
      if (parsed.rawCount < PAGE_SIZE) break;
      if (total !== null && (page + 1) * PAGE_SIZE >= total) break;
      if (page === pagesToFetch - 1) stopReason = probing ? 'probe' : 'max_pages';
    }
    if (stopReason === 'max_pages') {
      console.error(`⚠️  dayforce: ${entry?.name} stopped at ${pagesToFetch} pages${total !== null ? ` of ${Math.ceil(total / PAGE_SIZE)}` : ''} — raise max_pages on this entry for more`);
    }
    return jobs;
  },
};
