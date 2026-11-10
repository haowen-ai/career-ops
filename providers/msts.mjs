// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchTextWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

// "msts" career-site CMS provider (→ tracked_companies:).
//
// Branded career sites such as careers.lennar.com run on a hosted CMS whose
// assets come from cdn.cloudfront.msts.network and whose responses carry an
// `X-msts-health-check` header (Lennar links out to Paradox/Olivia for apply
// and talent communities). Postings live at
//   {origin}/job/{numericId}/{slug}?change_lang=en
// and the search page loads its result list from a server-rendered fragment
// (verified live 2026-11-07 by reading the page and replaying the call):
//
//   GET {origin}/api/requisitions/search/{lang}?page={1-based}[&keywords=…]
//   → HTML fragment:
//       <h3 class="job-search-results-info …">Results (11–20 of 363)</h3>
//       <table role="grid"> … <tr>
//         <td class="job-title"><a href="https://careers.lennar.com/job/2065/…?change_lang=en">Title</a></td>
//         <td class="job-location"><svg>…</svg> Houston, TX</td>
//         <td class="job-date">11/06/2026</td>
//       </tr> …
//
// - 10 rows per page; the server ignores per_page/limit/pageSize/etc.
//   Past the end it answers 200 with "Results (371–370 of 363)" and no rows.
// - careers_url query keys the search form uses (keywords, category_id,
//   subdivision_code, custom_fields[...]) are forwarded verbatim.
// - Host pinning: careers_url's host must be in ALLOWED_HOSTS (checked before
//   any request); every request goes to that https origin, and a posting link
//   is kept only when it is https on that same host.
// - A positive "of N" count with no parsable job rows is a parse error, not an
//   empty board (the row markup changed).
// - detect(): branded domains — wire explicitly with `provider: msts`.

const DEFAULT_MAX_PAGES = 80; // 800 rows at 10/page — Lennar is ~360
const MAX_PAGES_CAP = 500;
const DEFAULT_MAX_JOBS = 5000;
const INTER_PAGE_DELAY_MS = 200;
const FORWARD_KEYS = /^(keywords|category_id|subdivision_code|country_code|custom_fields\[[^\]]+\](\[\d*\])?)$/;
// Only career sites verified to run on this CMS; add a host after checking it live.
export const ALLOWED_HOSTS = new Set(['careers.lennar.com']);

/**
 * @param {any} entry
 * @returns {{origin: string, host: string, lang: string, forward: [string, string][]}}
 */
export function resolveConfig(entry) {
  const raw = entry?.careers_url || entry?.api;
  if (typeof raw !== 'string' || !raw) throw new Error('msts: careers_url is required');
  const u = new URL(raw); // throws on malformed input
  if (u.protocol !== 'https:') throw new Error(`msts: refusing non-https URL ${u.protocol}`);
  if (u.username || u.password) throw new Error('msts: credentials in careers_url are not allowed');
  const host = u.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host) || (u.port && u.port !== '443')) {
    throw new Error(`msts: host ${u.host} is not in the allowlist (${[...ALLOWED_HOSTS].join(', ')})`);
  }
  const forward = [];
  for (const [k, v] of u.searchParams) if (FORWARD_KEYS.test(k)) forward.push([k, v]);
  const lang = typeof entry?.lang === 'string' && /^[a-z]{2}(-[a-z]{2})?$/i.test(entry.lang) ? entry.lang : 'en';
  return { origin: u.origin, host, lang, forward };
}

/** @param {ReturnType<typeof resolveConfig>} cfg @param {number} page */
export function buildSearchUrl(cfg, page) {
  const q = new URLSearchParams({ page: String(page) });
  for (const [k, v] of cfg.forward) q.append(k, v);
  return `${cfg.origin}/api/requisitions/search/${cfg.lang}?${q.toString()}`;
}

/** @param {string} s */
function clean(s) {
  return decodeEntities(s.replace(/<svg[\s\S]*?<\/svg>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** MM/DD/YYYY → epoch ms (UTC midnight), NaN-safe. @param {string} s */
export function toEpochMs(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  if (!m) return undefined;
  const mo = Number(m[1]);
  const d = Number(m[2]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  return Date.UTC(Number(m[3]), mo - 1, d);
}

/**
 * Parse one results fragment.
 * - a string carrying the "Results (a–b of N)" header → rows (malformed rows skipped)
 * - a non-string, or HTML without that header → throw (not the endpoint we expect)
 * - a header saying this page holds jobs but no parsable rows → throw
 * @param {unknown} html @param {ReturnType<typeof resolveConfig>} cfg
 */
export function parseResults(html, cfg) {
  if (typeof html !== 'string') throw new Error(`msts: search returned ${typeof html}, expected HTML`);
  const head = html.match(/Results\s*\(\s*([\d,]+)\s*[–-]\s*([\d,]+)\s+of\s+([\d,]+)\s*\)/);
  if (!head) {
    const noRes = /job-search-results-info|No (?:jobs|results) found/i.test(html);
    throw new Error(`msts: unexpected search response (${noRes ? 'results header unreadable' : 'no results header'}; ${html.length} bytes)`);
  }
  const total = Number(head[3].replace(/,/g, ''));
  const rows = [];
  const seen = new Set();
  for (const tr of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cell = tr[1];
    const a = cell.match(/<td[^>]*class="[^"]*job-title[^"]*"[^>]*>[\s\S]*?<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue; // header row or malformed
    let url;
    try {
      url = new URL(decodeEntities(a[1]), `${cfg.origin}/`);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== cfg.host) continue;
    const idM = url.pathname.match(/\/job\/(\d+)(?:\/|$)/);
    if (!idM) continue;
    const title = clean(a[2]);
    if (!title || seen.has(idM[1])) continue;
    seen.add(idM[1]);
    const locM = cell.match(/<td[^>]*class="[^"]*job-location[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const dateM = cell.match(/<td[^>]*class="[^"]*job-date[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const row = { id: idM[1], title, url: url.href, location: locM ? clean(locM[1]) : '' };
    const postedAt = dateM ? toEpochMs(clean(dateM[1])) : undefined;
    if (postedAt !== undefined) row.postedAt = postedAt;
    rows.push(row);
  }
  const rawCount = (html.match(/<td[^>]*class="[^"]*job-title[^"]*"/gi) || []).length;
  const first = Number(head[1].replace(/,/g, ''));
  // The header says this page holds jobs (a ≤ b and a ≤ N, N > 0) — past the
  // end the server prints "Results (371–370 of 363)" with no rows, which is fine.
  if (total > 0 && first <= total && first <= Number(head[2].replace(/,/g, '')) && rows.length === 0) {
    throw new Error(`msts: results header reports ${total} jobs (from #${first}) but no job rows parsed (${rawCount} job-title cells; markup changed?)`);
  }
  return { rows, total: Number.isInteger(total) ? total : null, rawCount };
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

function resolveMaxJobs(entry) {
  const v = entry?.max_jobs;
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_MAX_JOBS;
}

/** @type {Provider} */
export default {
  id: 'msts',

  detect() {
    return null; // branded hosts — explicit `provider: msts` only
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry); // throws before any request on a bad URL
    const reqOpts = { redirect: 'error', headers: { accept: 'text/html', 'x-requested-with': 'XMLHttpRequest' } };

    const ctxMaxPages = Number(ctx?.maxPages);
    const probing = ctxMaxPages > 0;
    const maxPages = resolveMaxPages(entry);
    const pagesToFetch = Math.min(maxPages, probing ? ctxMaxPages : Infinity);
    const maxJobs = resolveMaxJobs(entry);

    const jobs = [];
    const seen = new Set();
    let total = null;
    let pageSize = null;
    let stopReason = 'end';
    for (let page = 1; page <= pagesToFetch; page++) {
      if (page > 1) await sleep(INTER_PAGE_DELAY_MS, ctx);
      let html;
      try {
        html = await fetchTextWithRetry(ctx, buildSearchUrl(cfg, page), reqOpts);
      } catch (err) {
        if (probing || page === 1) throw err; // unwrapped: probe budget identity must survive
        console.error(`⚠️  msts: ${entry.name} page ${page} failed (${err?.message}) — keeping ${jobs.length} postings`);
        stopReason = 'error';
        break;
      }
      const parsed = parseResults(html, cfg);
      if (total === null) total = parsed.total;
      if (parsed.rawCount === 0) break;
      if (pageSize === null) pageSize = parsed.rawCount;
      let fresh = 0;
      for (const row of parsed.rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        fresh++;
        const job = { title: row.title, url: row.url, company: entry.name, location: row.location };
        if (typeof row.postedAt === 'number') job.postedAt = row.postedAt;
        jobs.push(job);
      }
      if (jobs.length >= maxJobs) {
        stopReason = 'max_jobs';
        break;
      }
      if (fresh === 0) break;
      if (total !== null && jobs.length >= total) break;
      if (total !== null && page * pageSize >= total) break;
      if (page === pagesToFetch) stopReason = probing ? 'probe' : 'max_pages';
    }

    const out = jobs.slice(0, maxJobs);
    if ((stopReason === 'max_pages' || stopReason === 'max_jobs') && total !== null && out.length < total) {
      console.error(`⚠️  msts: ${entry.name} truncated at ${out.length} of ${total} postings — raise max_pages/max_jobs on this entry for more`);
    }
    return out;
  },
};
