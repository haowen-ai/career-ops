// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchTextWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

// BMW Group job finder provider (→ tracked_companies:).
//
// www.bmwgroup.jobs is an Adobe Experience Manager site. Each country page
// (`/{cc}/{lang}/jobs.html`, e.g. /us/en/jobs.html) renders an empty
// `<div class="grp-jobfinder" data-jobfinder-path="…">` shell, and the site's
// jobfinder.min.js fills it from an HTML fragment (verified live 2026-11-07 by
// reading /etc.clientlibs/grpw-web/comps/jobfinder/clientlibs/jobfinder.min.js
// and replaying its request):
//
//   requestUrl = location.href.split('.html')[0] + data-jobfinder-path
//   GET {requestUrl}?filterSearch=location_US&rowIndex=0&blockCount=100
//     e.g. https://www.bmwgroup.jobs/us/en/jobs/_jcr_content/main/
//          layoutcontainer_5337/jobfinder30.jobfinder_table.content.html
//   → <div class="grp-jobfinder__table" data-counter="24" …>
//       <div class="grp-jobfinder__wrapper" data-job-id="199972">
//         <a class="… grp-jobfinder__link-jobdescription"
//            href="/us/en/jobfinder/job-description-copy.199972.html">
//           <div class="grp-jobfinder-cell-refno" data-job-title="…"
//                data-job-location="Mountain View, CA" data-posting-date="20261106"
//                data-job-type="Internship">199972</div>
//           <div class="grp-jobfinder-cell-job-title-group__title">Intern, …</div>
//
// - The country scope is NOT in the URL: the page carries it as
//   `<div class="grp-jobfinder-filter-area" … data-prefilter="location=US">`
//   and the JS turns `key=v1,v2&&key2=v3` into `filterSearch=key_v1,key_v2,key2_v3`
//   (a `fulltext=` part becomes `textSearch`). Without it the US page lists the
//   global board (676 postings on 2026-11-07); with it, 24. So we fetch the
//   country page once, read both the component path and the prefilter, then
//   page the fragment. A `#location=US/Mountain View` hash on careers_url
//   overrides the page prefilter, exactly as the site's setPreFilter() does.
// - rowIndex is a 0-based row offset; blockCount is the page size (the site
//   sends 5; 100 and 200 are both honoured live). Past the end → no wrappers.
// - data-job-title is double-escaped (`&amp;amp;`); the visible title div is
//   single-escaped, so the title is read from the div first.
// - Host pinned to www.bmwgroup.jobs (careers_url is user config).

const ALLOWED_HOSTS = new Set(['www.bmwgroup.jobs']);
const BLOCK_COUNT = 100; // rows per fragment request
const DEFAULT_MAX_PAGES = 20; // 2,000 rows — the whole global board is ~700
const MAX_PAGES_CAP = 200; // hard ceiling even for a user max_pages override
const DEFAULT_MAX_JOBS = 2000;
const INTER_PAGE_DELAY_MS = 200;
const TIMEOUT_MS = 20_000;

/**
 * Validate careers_url/api and derive the country page URL.
 * Throws on a malformed URL, non-https, a host outside the allowlist, or a
 * path without the /{cc}/{lang}/ prefix.
 * @param {any} entry
 */
export function resolveConfig(entry) {
  const raw = entry?.api || entry?.careers_url;
  if (typeof raw !== 'string' || !raw) throw new Error('bmwgroup: careers_url is required');
  const u = new URL(raw); // throws on malformed input
  if (u.protocol !== 'https:') throw new Error(`bmwgroup: refusing non-https URL ${u.protocol}`);
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) throw new Error(`bmwgroup: host not allowed: ${u.hostname}`);
  const m = u.pathname.match(/^\/([a-z]{2})\/([a-z]{2})(?:\/|$)/i);
  if (!m) throw new Error(`bmwgroup: careers_url must look like https://www.bmwgroup.jobs/{country}/{lang}/jobs.html, got ${u.pathname}`);
  const country = m[1].toLowerCase();
  const lang = m[2].toLowerCase();
  const pagePath = /\.html$/i.test(u.pathname) ? u.pathname : `/${country}/${lang}/jobs.html`;
  let hash = '';
  try {
    hash = decodeURIComponent(u.hash.replace(/^#/, ''));
  } catch {
    hash = u.hash.replace(/^#/, '');
  }
  return { origin: u.origin, country, lang, pageUrl: `${u.origin}${pagePath}`, hashFilter: /^[A-Za-z]+=.+/.test(hash) ? hash : '' };
}

/**
 * Read the jobfinder component path and default prefilter from the country page.
 * @param {string} html
 * @returns {{componentPath: string|null, prefilter: string}}
 */
export function parseJobfinderPage(html) {
  if (typeof html !== 'string') return { componentPath: null, prefilter: '' };
  const pathM = html.match(/data-jobfinder-path="([^"]+)"/);
  let componentPath = pathM ? decodeEntities(pathM[1]) : null;
  // Only a same-site absolute path of plain segments — never a scheme/host.
  if (componentPath && !/^\/[\w\-./]+\.html$/.test(componentPath)) componentPath = null;
  const areaM = html.match(/<div[^>]*class="[^"]*grp-jobfinder-filter-area[^"]*"[^>]*>/);
  const preM = areaM ? areaM[0].match(/data-prefilter="([^"]*)"/) : null;
  return { componentPath, prefilter: preM ? decodeEntities(preM[1]) : '' };
}

/**
 * Translate a site prefilter (`location=US&&jobType=Internship,General`) into
 * the fragment's query params, mirroring jobfinder.min.js processPreFilter().
 * @param {string} prefilter
 * @returns {{filterSearch: string, textSearch: string}}
 */
export function prefilterToQuery(prefilter) {
  const filters = [];
  let textSearch = '';
  for (const part of String(prefilter || '').split('&&')) {
    const values = part.split(',');
    const eq = values[0].indexOf('=');
    if (eq <= 0) continue;
    const key = values[0].slice(0, eq).trim();
    const first = values[0].slice(eq + 1).trim();
    if (!/^[A-Za-z]+$/.test(key) || !first) continue;
    if (key.toLowerCase() === 'fulltext') {
      textSearch = first;
      continue;
    }
    filters.push(`${key}_${first}`);
    for (const v of values.slice(1)) if (v.trim()) filters.push(`${key}_${v.trim()}`);
  }
  return { filterSearch: filters.join(','), textSearch };
}

/** @param {string} s */
function clean(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** YYYYMMDD → epoch ms (UTC midnight), NaN-safe. @param {unknown} v */
export function toEpochMs(v) {
  const m = typeof v === 'string' ? v.match(/^(\d{4})(\d{2})(\d{2})$/) : null;
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  const ms = Date.UTC(y, mo - 1, d);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Parse one jobfinder table fragment.
 * Returns `null` total when the fragment has no table element at all.
 * @param {string} html
 * @param {string} origin
 * @param {{country: string, lang: string}} site
 */
export function parseFragment(html, origin, site) {
  const out = [];
  if (typeof html !== 'string' || !html.trim()) return { rows: out, rawCount: 0, total: 0, hasTable: false, empty: true };
  const tableM = html.match(/<div[^>]*class="[^"]*grp-jobfinder__table[^"]*"[^>]*>/);
  const counterM = tableM ? tableM[0].match(/data-counter="(\d+)"/) : null;
  const total = counterM ? Number(counterM[1]) : null;
  const blocks = html.split(/<div class="grp-jobfinder__wrapper"/).slice(1);
  for (const block of blocks) {
    const idM = block.match(/^[^>]*data-job-id="(\d+)"/);
    const id = idM ? idM[1] : null;
    const hrefM = block.match(/<a[^>]*grp-jobfinder__link-jobdescription[^>]*href="([^"]+)"/) || block.match(/<a[^>]*href="([^"]*job-description[^"]*)"/);
    const titleM = block.match(/grp-jobfinder-cell-job-title-group__title">([\s\S]*?)<\/div>/);
    const dataTitleM = block.match(/data-job-title="([^"]*)"/);
    // data-job-title is escaped twice (&amp;amp;) — decode it twice.
    const title = titleM ? clean(titleM[1]) : dataTitleM ? clean(decodeEntities(dataTitleM[1])) : '';
    let url = null;
    if (hrefM) {
      const href = decodeEntities(hrefM[1]);
      try {
        const abs = new URL(href, origin);
        if (abs.origin === origin) url = abs.href;
      } catch {
        url = null;
      }
    }
    if (!url && id) url = `${origin}/${site.country}/${site.lang}/jobfinder/job-description-copy.${id}.html`;
    if (!title || !url) continue;
    const locM = block.match(/data-job-location="([^"]*)"/);
    const dateM = block.match(/data-posting-date="([^"]*)"/);
    out.push({ id: id || url, title, url, location: locM ? clean(locM[1]) : '', postedAt: toEpochMs(dateM ? dateM[1] : undefined) });
  }
  return { rows: out, rawCount: blocks.length, total, hasTable: Boolean(tableM), empty: false };
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
  id: 'bmwgroup',

  detect(entry) {
    // Pinned single-company host — safe to claim by URL pattern.
    try {
      const raw = entry?.careers_url || entry?.api;
      if (typeof raw !== 'string') return null;
      const u = new URL(raw);
      if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname.toLowerCase())) return null;
      if (!/^\/[a-z]{2}\/[a-z]{2}(\/|$)/i.test(u.pathname)) return null;
      return { url: u.href };
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry); // throws before any request on a bad host
    const reqOpts = { redirect: 'error', timeoutMs: TIMEOUT_MS, headers: { accept: 'text/html' } };

    const pageHtml = await fetchTextWithRetry(ctx, cfg.pageUrl, reqOpts);
    const { componentPath, prefilter } = parseJobfinderPage(pageHtml);
    if (!componentPath) throw new Error(`bmwgroup: no data-jobfinder-path on ${cfg.pageUrl} — page layout changed?`);
    const { filterSearch, textSearch } = prefilterToQuery(cfg.hashFilter || prefilter);
    const requestBase = cfg.pageUrl.split('.html')[0] + componentPath;

    const ctxMaxPages = Number(ctx?.maxPages);
    const probing = ctxMaxPages > 0;
    const maxPages = resolveMaxPages(entry);
    const pagesToFetch = Math.min(maxPages, probing ? ctxMaxPages : Infinity);
    const maxJobs = resolveMaxJobs(entry);

    const jobs = [];
    const seen = new Set();
    let total = null;
    let stopReason = 'end';
    for (let page = 0; page < pagesToFetch; page++) {
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const q = new URLSearchParams();
      if (textSearch) q.set('textSearch', textSearch);
      if (filterSearch) q.set('filterSearch', filterSearch);
      q.set('rowIndex', String(page * BLOCK_COUNT));
      q.set('blockCount', String(BLOCK_COUNT));
      let html;
      try {
        html = await fetchTextWithRetry(ctx, `${requestBase}?${q.toString()}`, reqOpts);
      } catch (err) {
        if (probing || page === 0) throw err; // unwrapped: probe budget identity must survive
        console.error(`⚠️  bmwgroup: ${entry.name} page ${page + 1} failed (${err?.message}) — keeping ${jobs.length} postings`);
        stopReason = 'error';
        break;
      }
      const parsed = parseFragment(html, cfg.origin, cfg);
      if (parsed.empty) break;
      if (!parsed.hasTable) {
        if (page === 0) throw new Error('bmwgroup: fragment has no grp-jobfinder__table element — endpoint changed?');
        break;
      }
      if (total === null && parsed.total !== null) total = parsed.total;
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
      if (parsed.rawCount < BLOCK_COUNT || fresh === 0) break;
      if (total !== null && (page + 1) * BLOCK_COUNT >= total) break;
      if (page === pagesToFetch - 1) stopReason = probing ? 'probe' : 'max_pages';
    }

    const out = jobs.slice(0, maxJobs);
    if ((stopReason === 'max_pages' || stopReason === 'max_jobs') && total !== null && out.length < total) {
      console.error(`⚠️  bmwgroup: ${entry.name} truncated at ${out.length} of ${total} postings — raise max_pages/max_jobs on this entry for more`);
    }
    return out;
  },
};
