// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchTextWithRetry, BROWSER_LIKE_USER_AGENT } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

// D. E. Shaw careers provider (→ tracked_companies:).
//
// www.deshaw.com/careers is a Next.js page that server-renders the whole job
// board into its __NEXT_DATA__ script (verified live 2026-11-07, one ~1 MB
// GET, no paging, no separate API):
//
//   props.pageProps = {
//     regularJobs: [{ data: { id: 6012, displayName: "Receptionist (Singapore)",
//                             jobUrl: "Receptionist-Singapore-6012",
//                             activeOnJobsListing: true,
//                             jobMetadata: { jobLocations: [{ name: "New York", abbreviation: "NYC" }] } },
//                     id, displayName, office: [{ abbreviation, name }], … }],
//     internships:  [ same shape ],
//     internalJobs: [ … activeOnJobsListing:false — not public, skipped ],
//     jobsFetchingError: <falsy when OK>,
//     …
//   }
//
// - Posting URL is https://www.deshaw.com/careers/{jobUrl lowercased} (the
//   mixed-case form 308-redirects to the lowercase one).
// - The site has no country filter; all public postings are returned and the
//   scanner's location_filter does the rest. Office names are mapped to a
//   "City, ST, US" string for the US offices so location filters match.
// - Host pinned to www.deshaw.com; the fetched URL is a fixed literal.

const ALLOWED_HOSTS = new Set(['www.deshaw.com', 'deshaw.com']);
const PAGE_URL = 'https://www.deshaw.com/careers';
const SITE_ORIGIN = 'https://www.deshaw.com';
const TIMEOUT_MS = 30_000;
const LISTS = ['regularJobs', 'internships'];

// Office abbreviation → location text (US offices get state + country so the
// scanner's location filter sees them as US).
const OFFICE_LOCATIONS = {
  NYC: 'New York, NY, US',
  DEN: 'Denver, CO, US',
};

/** @param {any} entry */
export function assertDeshawUrl(entry) {
  const raw = entry?.careers_url || entry?.api;
  if (typeof raw !== 'string' || !raw) throw new Error('deshaw: careers_url is required');
  const u = new URL(raw); // throws on malformed input
  if (u.protocol !== 'https:') throw new Error(`deshaw: refusing non-https URL ${u.protocol}`);
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) throw new Error(`deshaw: host not allowed: ${u.hostname}`);
  return u;
}

/** @param {unknown} s */
function clean(s) {
  return typeof s === 'string' ? decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
}

/** @param {any} loc */
function locationText(loc) {
  if (!loc || typeof loc !== 'object') return '';
  const abbr = typeof loc.abbreviation === 'string' ? loc.abbreviation.toUpperCase() : '';
  if (Object.prototype.hasOwnProperty.call(OFFICE_LOCATIONS, abbr)) return OFFICE_LOCATIONS[abbr];
  return clean(loc.name);
}

/**
 * Extract and parse the __NEXT_DATA__ JSON from the careers page.
 * Throws when the script is missing or not JSON (page changed / blocked).
 * @param {string} html
 */
export function extractNextData(html) {
  if (typeof html !== 'string') throw new Error('deshaw: careers page body is not text');
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('deshaw: __NEXT_DATA__ not found on careers page (page changed or blocked)');
  try {
    return JSON.parse(m[1]);
  } catch (err) {
    throw new Error(`deshaw: __NEXT_DATA__ is not valid JSON (${err?.message})`);
  }
}

/**
 * Turn the page's pageProps into rows.
 * - jobsFetchingError truthy → throw (site says its own job fetch failed)
 * - regularJobs/internships missing or not arrays → throw (shape changed)
 * - both arrays empty → [] (genuinely no postings)
 * @param {any} nextData
 */
export function parseDeshawJobs(nextData) {
  const pp = nextData?.props?.pageProps;
  if (!pp || typeof pp !== 'object' || Array.isArray(pp)) {
    throw new Error('deshaw: __NEXT_DATA__ has no props.pageProps object');
  }
  if (pp.jobsFetchingError) {
    throw new Error(`deshaw: site reports jobsFetchingError (${typeof pp.jobsFetchingError === 'string' ? pp.jobsFetchingError : 'true'})`);
  }
  for (const key of LISTS) {
    if (!Array.isArray(pp[key])) {
      throw new Error(`deshaw: unexpected pageProps shape (${key} is ${pp[key] === undefined ? 'missing' : typeof pp[key]}; keys: ${Object.keys(pp).slice(0, 10).join(', ')})`);
    }
  }
  const rows = [];
  const seen = new Set();
  for (const key of LISTS) {
    for (const item of pp[key]) {
      const d = item?.data;
      if (!d || typeof d !== 'object') continue;
      if (d.activeOnJobsListing === false) continue;
      const title = clean(d.displayName) || clean(item.displayName);
      if (!title || typeof d.jobUrl !== 'string' || !/^[A-Za-z0-9-]+$/.test(d.jobUrl)) continue;
      // jobUrl is checked against a slug charset above, so it is URL-safe as is.
      const url = `${SITE_ORIGIN}/careers/${d.jobUrl.toLowerCase()}`;
      if (seen.has(url)) continue;
      seen.add(url);
      const locs = Array.isArray(d.jobMetadata?.jobLocations) ? d.jobMetadata.jobLocations : Array.isArray(item.office) ? item.office : [];
      const location = [...new Set(locs.map(locationText).filter(Boolean))].join('; ');
      const id = typeof d.id === 'number' || typeof d.id === 'string' ? String(d.id) : url;
      rows.push({ id, title, url, location });
    }
  }
  return rows;
}

/** @type {Provider} */
export default {
  id: 'deshaw',

  detect(entry) {
    try {
      const raw = entry?.careers_url || entry?.api;
      if (typeof raw !== 'string') return null;
      const u = new URL(raw);
      if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname.toLowerCase())) return null;
      if (!/^\/careers(\/|$)/.test(u.pathname)) return null;
      return { url: PAGE_URL };
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    assertDeshawUrl(entry); // throws before any request on a bad host
    const html = await fetchTextWithRetry(ctx, PAGE_URL, {
      redirect: 'error',
      timeoutMs: TIMEOUT_MS,
      headers: { 'user-agent': BROWSER_LIKE_USER_AGENT, accept: 'text/html' },
    });
    const rows = parseDeshawJobs(extractNextData(html));
    return rows.map((r) => ({ title: r.title, url: r.url, company: entry.name, location: r.location }));
  },
};
