// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchTextWithRetry, sleep, BROWSER_LIKE_USER_AGENT } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

// BNP Paribas group careers provider (→ tracked_companies:).
//
// group.bnpparibas/en/careers/all-job-offers is a server-rendered Symfony page
// (verified live 2026-11-07). Facets are path segments — the country facet for
// the US is /en/careers/all-job-offers/united-states ("Job offers in the
// country United States", 38 offers that day). Ten cards per page; page N is
// ?page=N, and a page past the end 302-redirects back to page 1, so the walk
// is bounded by the total the page prints and by our own page cap, never by
// following that redirect.
//
//   <h2 …><span class="nb-total spanGreen">38</span> job offers in …</h2>
//   <article class="card-custom card-offer category-2">
//     <a href="/en/careers/job-offer/{slug}" class="card-link"> …
//       <div class="offer-type">Permanent</div>
//       <h3 class="title-4">2028 - Summer Analyst Internship – …</h3>
//       <div class="offer-location"> <span class="icon …"></span> New York, New York, United States </div>
//
// - The site's JSON list endpoint (?json=1) and the default User-Agent are
//   refused by the CDN; the HTML page answers a browser-like User-Agent, which
//   _http.mjs exports for exactly this case. No cookies, no challenge solving.
// - Host pinned to group.bnpparibas; path must be the job-offer list (optionally
//   with up to three facet slugs). Any query string on careers_url is ignored.
// - Not backed by a supported ATS: postings link to the group site's own
//   /job-offer/ pages.

const ALLOWED_HOSTS = new Set(['group.bnpparibas']);
const SITE_ORIGIN = 'https://group.bnpparibas';
const LIST_PATH_RE = /^\/(?:(en)\/)?careers\/all-job-offers((?:\/[a-z0-9-]+){0,3})\/?$/;
const OFFER_PATH_RE = /^\/(?:en\/)?careers\/job-offer\/[a-z0-9-]+$/;
const PAGE_SIZE = 10;
const DEFAULT_MAX_PAGES = 30; // 300 postings — the US view is ~40
const MAX_PAGES_CAP = 300;
const INTER_PAGE_DELAY_MS = 400;
const TIMEOUT_MS = 30_000;

/**
 * Validate careers_url and return the list URL (path only, no query).
 * Throws on malformed URL, non-https, foreign host, or a non-list path.
 * @param {any} entry
 */
export function resolveListUrl(entry) {
  const raw = entry?.careers_url || entry?.api;
  if (typeof raw !== 'string' || !raw) throw new Error('bnpparibas: careers_url is required');
  const u = new URL(raw); // throws on malformed input
  if (u.protocol !== 'https:') throw new Error(`bnpparibas: refusing non-https URL ${u.protocol}`);
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) throw new Error(`bnpparibas: host not allowed: ${u.hostname}`);
  const path = u.pathname.toLowerCase();
  if (!LIST_PATH_RE.test(path)) throw new Error(`bnpparibas: careers_url must be a /careers/all-job-offers list page (got ${u.pathname})`);
  return `${SITE_ORIGIN}${path.replace(/\/$/, '')}`;
}

/** @param {string} listUrl @param {number} page 1-based */
export function buildPageUrl(listUrl, page) {
  return page <= 1 ? listUrl : `${listUrl}?page=${page}`;
}

/** @param {unknown} s */
function clean(s) {
  return typeof s === 'string' ? decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
}

/**
 * Parse one list page.
 * - total: the printed result count (null when the counter is absent)
 * - rows: one per well-formed offer card; a malformed card is skipped
 * Throws when the page is not a job-offer list at all (no counter and no
 * result list — a block page, a redesign, or an error page).
 * @param {unknown} html
 */
export function parseListPage(html) {
  if (typeof html !== 'string') throw new Error('bnpparibas: list page body is not text');
  const totalMatch = html.match(/class="nb-total[^"]*"[^>]*>\s*([\d.,\s  ]+?)\s*</);
  const hasList = /<ul class="results rh-results"/.test(html);
  if (!totalMatch && !hasList) {
    const title = (html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '').trim().slice(0, 80);
    throw new Error(`bnpparibas: unexpected list page (no result counter or result list; title: ${title || 'none'})`);
  }
  const total = totalMatch ? Number(totalMatch[1].replace(/[^\d]/g, '')) : null;
  const rows = [];
  const cards = html.match(/<article class="card-custom card-offer[\s\S]*?<\/article>/g) || [];
  for (const card of cards) {
    const href = card.match(/<a href="([^"]+)"/)?.[1];
    if (!href) continue;
    let url;
    try {
      const u = new URL(decodeEntities(href), SITE_ORIGIN);
      if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname) || !OFFER_PATH_RE.test(u.pathname)) continue;
      url = `${SITE_ORIGIN}${u.pathname}`;
    } catch {
      continue;
    }
    const title = clean(card.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1]);
    if (!title) continue;
    const location = clean(card.match(/class="offer-location"[^>]*>([\s\S]*?)<\/div>/)?.[1]);
    rows.push({ id: url, title, url, location });
  }
  return { total: Number.isFinite(total) ? total : null, rows, rawCount: cards.length };
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

/** @type {Provider} */
export default {
  id: 'bnpparibas',

  detect(entry) {
    try {
      return { url: resolveListUrl(entry) };
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const listUrl = resolveListUrl(entry); // throws before any request on a bad host/path
    const reqOpts = {
      redirect: 'error',
      timeoutMs: TIMEOUT_MS,
      headers: { 'user-agent': BROWSER_LIKE_USER_AGENT, accept: 'text/html' },
    };
    const ctxMaxPages = Number(ctx?.maxPages);
    const probing = ctxMaxPages > 0;
    const maxPages = resolveMaxPages(entry);

    const jobs = [];
    const seen = new Set();
    let total = null;
    let lastPage = 1;
    let stopReason = 'end';
    for (let page = 1; page <= lastPage; page++) {
      if (page > 1) await sleep(INTER_PAGE_DELAY_MS, ctx);
      let html;
      try {
        html = await fetchTextWithRetry(ctx, buildPageUrl(listUrl, page), reqOpts);
      } catch (err) {
        if (probing || page === 1) throw err; // unwrapped: probe budget identity must survive
        console.error(`⚠️  bnpparibas: ${entry.name} page ${page} failed (${err?.message}) — keeping ${jobs.length} postings`);
        stopReason = 'error';
        break;
      }
      let parsed;
      try {
        parsed = parseListPage(html);
        // Every later page must look like page 1: a counter and at least one
        // offer card (page <= lastPage was computed from the page-1 total).
        if (page > 1 && (parsed.total === null || parsed.rawCount === 0)) {
          throw new Error(`page ${page} has ${parsed.total === null ? 'no result counter' : `counter ${parsed.total}`} and ${parsed.rawCount} offer cards`);
        }
      } catch (err) {
        if (probing || page === 1) throw err;
        console.error(`⚠️  bnpparibas: ${entry.name} page ${page} unreadable (${err?.message}) — keeping ${jobs.length} postings`);
        stopReason = 'error';
        break;
      }
      if (page === 1) {
        total = parsed.total;
        if (total === 0) return [];
        if (total === null) throw new Error('bnpparibas: result counter missing on page 1');
        if (parsed.rawCount === 0) throw new Error(`bnpparibas: page 1 reports ${total} offers but has no offer cards (markup changed?)`);
        const needed = Math.ceil(total / PAGE_SIZE);
        lastPage = Math.min(needed, maxPages, probing ? ctxMaxPages : Infinity);
        if (needed > maxPages && !probing) stopReason = 'max_pages';
      }
      for (const row of parsed.rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        jobs.push({ title: row.title, url: row.url, company: entry.name, location: row.location });
      }
      if (parsed.rawCount === 0) break;
    }
    if (stopReason === 'max_pages' && total !== null && jobs.length < total) {
      console.error(`⚠️  bnpparibas: ${entry.name} truncated at ${jobs.length} of ${total} postings — raise max_pages on this entry for more`);
    }
    return jobs;
  },
};
