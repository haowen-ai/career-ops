// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { BROWSER_LIKE_USER_AGENT, fetchTextWithRetry } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

// Oracle Taleo SelectMinds (referral / "OTAC" career community) provider
// (→ tracked_companies:). Some Taleo customers publish their public job list
// only here — Energy Transfer's Taleo Enterprise tenant has no public career
// section; its postings are on energytransfer.referrals.selectminds.com.
//
// careers_url shape:
//   https://<tenant>.referrals.selectminds.com/<COMMUNITY>/          e.g. /ETP/
//   (also <tenant>.selectminds.com)
//
// Server-rendered search, verified live 2026-11-08 (Energy Transfer, 274 jobs):
//   GET  /<COMMUNITY>/jobs/search            → 307 Location: /<COMMUNITY>/jobs/search/<sid>
//   GET  /<COMMUNITY>/jobs/search/<sid>      → page 1 (10 rows)
//   GET  /<COMMUNITY>/jobs/search/<sid>/page<N>
//   <span class="total_results">274</span>
//   <a href="https://<host>/<COMMUNITY>/jobs/<slug>-<id>" class="job_link font_bold">Title</a>
//   <span class="location"> HOUSTON, Texas, United States </span>
// The search id is not tied to a cookie. Past the last page the server
// redirects again, so the loop is driven by total_results and stops before.
//
// Guards: host allowlist and community shape enforced before any request;
// the redirect is read with redirect:'manual' and only a same-host
// /<COMMUNITY>/jobs/search/<digits> target is accepted; every other request
// uses redirect:'error'. A page without total_results, or a total with rows
// that cannot be parsed, throws; one bad row is skipped and counted; paging
// follows raw row counts, is bounded by max_pages, and a shortfall against
// total_results is reported as truncated.

const HOST_RE = /^[a-z0-9-]{2,40}\.(?:referrals\.)?selectminds\.com$/;
const COMMUNITY_RE = /^[A-Za-z0-9_-]{1,40}$/;
const PAGE_SIZE = 10;
const DEFAULT_MAX_PAGES = 100;
const MAX_PAGES_CAP = 500;
const INTER_PAGE_DELAY_MS = 300;
const HEADERS = { 'User-Agent': BROWSER_LIKE_USER_AGENT, Accept: 'text/html' };

/**
 * @param {any} entry
 * @returns {{host:string, community:string, origin:string}}
 */
export function resolveConfig(entry) {
  const raw = entry?.careers_url || entry?.api;
  if (typeof raw !== 'string' || !raw) throw new Error('selectminds: careers_url is required');
  const u = new URL(raw);
  if (u.protocol !== 'https:') throw new Error(`selectminds: refusing non-https URL ${u.protocol}`);
  const host = u.hostname.toLowerCase();
  if (!HOST_RE.test(host)) throw new Error(`selectminds: host not allowed: ${u.hostname}`);
  if (u.username || u.password || u.port) throw new Error('selectminds: credentials/port not allowed in careers_url');
  const community = u.pathname.split('/').filter(Boolean)[0] || '';
  if (!COMMUNITY_RE.test(community)) throw new Error(`selectminds: careers_url must start with /<COMMUNITY>/, got ${u.pathname}`);
  return { host, community, origin: `https://${host}` };
}

/** @param {{origin:string, community:string}} cfg @param {string} sid @param {number} page */
export function buildPageUrl(cfg, sid, page) {
  return `${cfg.origin}/${cfg.community}/jobs/search/${sid}${page > 1 ? `/page${page}` : ''}`;
}

/**
 * Validate the search redirect target; returns the search id.
 * @param {string|null|undefined} location
 * @param {{origin:string, community:string, host:string}} cfg
 */
export function searchIdFromLocation(location, cfg) {
  if (typeof location !== 'string' || !location) throw new Error('selectminds: search did not redirect to a result set');
  const u = new URL(location, `${cfg.origin}/`);
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== cfg.host) throw new Error(`selectminds: search redirected off-host (${u.hostname})`);
  const m = new RegExp(`^/${cfg.community}/jobs/search/(\\d{1,15})$`).exec(u.pathname);
  if (!m) throw new Error(`selectminds: unexpected search redirect ${u.pathname}`);
  return m[1];
}

/** @param {string} s */
function text(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Parse one results page.
 * @param {string} html
 * @param {{origin:string, community:string, host:string}} cfg
 * @param {string} companyName
 */
export function parsePage(html, cfg, companyName) {
  if (typeof html !== 'string' || !html) throw new Error('selectminds: empty results page');
  const tm = /<span class="total_results">\s*([\d,]+)\s*<\/span>/.exec(html);
  if (!tm) throw new Error('selectminds: results page has no total_results (layout changed or request blocked)');
  const total = Number(tm[1].replace(/,/g, ''));
  // One row = one job_list_row block; split so a row's location stays with its title.
  const blocks = html.split(/<div id="job_list_\d+" class="job_list_row/).slice(1);
  const jobs = [];
  let skipped = 0;
  // Slugs may be percent-encoded ("c%23-angular", "intern-%E2%80%93-…"); the id is the trailing number.
  const idRe = new RegExp(`^/${cfg.community}/jobs/(?:[^/]*-)?(\\d{1,12})$`);
  for (const b of blocks) {
    try {
      const a = /<a href="([^"]+)" class="job_link[^"]*">([\s\S]*?)<\/a>/.exec(b);
      if (!a) { skipped++; continue; }
      const u = new URL(decodeEntities(a[1]), `${cfg.origin}/`);
      const idm = idRe.exec(u.pathname);
      const title = text(a[2]);
      if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== cfg.host || !idm || !title) { skipped++; continue; }
      const loc = /<span class="location">([\s\S]*?)<\/span>/.exec(b);
      jobs.push({ id: idm[1], title, url: `${cfg.origin}${u.pathname}`, company: companyName, location: loc ? text(loc[1]) : '' });
    } catch {
      skipped++;
    }
  }
  if (blocks.length > 0 && jobs.length === 0) throw new Error(`selectminds: ${blocks.length} rows but none parsed (markup changed?)`);
  if (total > 0 && blocks.length === 0 && /class="job_link/.test(html)) throw new Error('selectminds: job links present but no job_list_row blocks (markup changed?)');
  return { jobs, rawCount: blocks.length, skipped, total };
}

/** @param {any} entry @param {any} ctx */
function resolveMaxPages(entry, ctx) {
  const v = entry?.max_pages;
  const fromEntry = Number.isInteger(v) && v > 0 ? Math.min(v, MAX_PAGES_CAP) : DEFAULT_MAX_PAGES;
  const hint = Number(ctx?.maxPages);
  return Number.isFinite(hint) && hint > 0 ? Math.min(fromEntry, Math.floor(hint)) : fromEntry;
}

/** @param {number} ms @param {any} ctx */
function sleep(ms, ctx) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Open a result set: GET /<COMMUNITY>/jobs/search with redirect:'manual'.
 * The HTTP layer surfaces the 3xx as an error carrying `.location`.
 * @param {any} ctx @param {{origin:string, community:string, host:string}} cfg
 */
async function openSearch(ctx, cfg) {
  const url = `${cfg.origin}/${cfg.community}/jobs/search`;
  try {
    await ctx.fetchText(url, { redirect: 'manual', headers: HEADERS });
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (typeof e?.status === 'number' && e.status >= 300 && e.status < 400) return searchIdFromLocation(e.location, cfg);
    throw err;
  }
  throw new Error('selectminds: search did not redirect to a result set');
}

/** @type {Provider} */
export default {
  id: 'selectminds',

  detect(entry) {
    try {
      const raw = entry?.careers_url || entry?.api;
      if (typeof raw !== 'string') return null;
      const cfg = resolveConfig({ careers_url: raw });
      return { url: `${cfg.origin}/${cfg.community}/jobs/search` };
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry); // throws before any request
    const sid = await openSearch(ctx, cfg);
    const maxPages = resolveMaxPages(entry, ctx);
    const seen = new Set();
    const all = [];
    let raw = 0;
    let skipped = 0;
    /** @type {number|null} */
    let total = null;
    let pages = 0;
    for (let page = 1; page <= maxPages; page++) {
      await sleep(INTER_PAGE_DELAY_MS, ctx);
      const html = await fetchTextWithRetry(ctx, buildPageUrl(cfg, sid, page), { redirect: 'error', headers: HEADERS });
      pages = page;
      const res = parsePage(html, cfg, entry.name);
      if (total === null) total = res.total;
      raw += res.rawCount;
      skipped += res.skipped;
      for (const j of res.jobs) {
        if (seen.has(j.id)) continue;
        seen.add(j.id);
        all.push(j);
      }
      if (res.rawCount === 0 || raw >= total || page * PAGE_SIZE >= total) break;
    }
    if (skipped > 0) console.error(`⚠️  selectminds: ${entry.name} skipped ${skipped} malformed rows`);
    if (total !== null && raw < total) {
      console.error(`⚠️  selectminds: ${entry.name} truncated (${pages >= maxPages ? `max_pages=${maxPages}` : 'short pages'}): ${raw} of ${total} rows read`);
    }
    return all;
  },
};
