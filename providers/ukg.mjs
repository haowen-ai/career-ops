// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchJsonWithRetry, sleep } from './_http.mjs';

// UKG Pro Recruiting (UltiPro) job board provider (→ tracked_companies:).
//
// careers_url shape:
//   https://recruiting.ultipro.com/<TENANT>/JobBoard/<board uuid>/
//   (recruiting2.ultipro.com is the same product on a second cluster)
//
// The board is an SPA; its list comes from a public, no-auth JSON endpoint on
// the same host (verified live 2026-11-08, Welltower, 93 postings):
//   POST https://<host>/<TENANT>/JobBoard/<board>/JobBoardView/LoadSearchResults
//   body: {"opportunitySearch":{"Top":50,"Skip":<n>,"QueryString":"","OrderBy":[…],"Filters":[]},
//          "matchCriteria":{…empty…}}
//   → { opportunities: [ { Id, Title, RequisitionNumber, PostedDate,
//         Locations: [{ LocalizedDescription, Address: { City, State: {Code}, Country: {Code} } }] } ],
//       totalCount }
// Posting page: https://<host>/<TENANT>/JobBoard/<board>/OpportunityDetail?opportunityId=<Id>
//
// Guards: host allowlist, tenant/board shape and https enforced before any
// request; redirects refused; a body without an opportunities array or a
// numeric totalCount throws; malformed rows are skipped and counted, a page
// whose rows all fail throws; paging follows the raw row count, is bounded
// by max_pages, and a shortfall against totalCount is reported as truncated.

const HOSTS = new Set(['recruiting.ultipro.com', 'recruiting2.ultipro.com']);
const PATH_RE = /^\/([A-Za-z0-9]{3,20})\/JobBoard\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/.*)?$/i;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 60;
const MAX_PAGES_CAP = 400;
const INTER_PAGE_DELAY_MS = 300;

/**
 * @param {any} entry
 * @returns {{host:string, tenant:string, board:string, base:string}}
 */
export function resolveConfig(entry) {
  const raw = entry?.careers_url || entry?.api;
  if (typeof raw !== 'string' || !raw) throw new Error('ukg: careers_url is required');
  const u = new URL(raw);
  if (u.protocol !== 'https:') throw new Error(`ukg: refusing non-https URL ${u.protocol}`);
  const host = u.hostname.toLowerCase();
  if (!HOSTS.has(host)) throw new Error(`ukg: host not allowed: ${u.hostname}`);
  if (u.username || u.password || u.port) throw new Error('ukg: credentials/port not allowed in careers_url');
  const m = PATH_RE.exec(u.pathname);
  if (!m || u.pathname.includes('..')) throw new Error(`ukg: careers_url must be /<TENANT>/JobBoard/<board uuid>/, got ${u.pathname}`);
  const tenant = m[1];
  const board = m[2].toLowerCase();
  return { host, tenant, board, base: `https://${host}/${tenant}/JobBoard/${board}` };
}

/** @param {number} skip */
export function buildSearchBody(skip) {
  return JSON.stringify({
    opportunitySearch: {
      Top: PAGE_SIZE,
      Skip: skip,
      QueryString: '',
      OrderBy: [{ Value: 'postedDateDesc', PropertyName: 'PostedDate', Ascending: false }],
      Filters: [],
    },
    matchCriteria: { PreferredJobs: [], Educations: [], LicenseAndCertifications: [], Skills: [], hasNoLicenses: false, SkippedSkills: [] },
  });
}

/** @param {unknown} s */
function clean(s) {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
}

/**
 * @param {any} json
 * @param {{base:string}} cfg
 * @param {string} companyName
 */
export function parsePage(json, cfg, companyName) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('ukg: response is not a JSON object');
  if (!Array.isArray(json.opportunities)) throw new Error(`ukg: response has no opportunities array (keys: ${Object.keys(json).slice(0, 8).join(', ') || 'none'})`);
  if (typeof json.totalCount !== 'number' || !Number.isFinite(json.totalCount) || json.totalCount < 0) {
    throw new Error(`ukg: totalCount is not a number (${JSON.stringify(json.totalCount)})`);
  }
  const jobs = [];
  let skipped = 0;
  for (const o of json.opportunities) {
    try {
      const id = typeof o?.Id === 'string' ? o.Id.trim() : '';
      const title = clean(o?.Title);
      if (!ID_RE.test(id) || !title) { skipped++; continue; }
      const locs = [];
      if (Array.isArray(o.Locations)) {
        for (const l of o.Locations) {
          const a = l?.Address;
          const parts = [clean(a?.City), clean(a?.State?.Code), clean(a?.Country?.Code)].filter(Boolean);
          const name = parts.length ? parts.join(', ') : clean(l?.LocalizedDescription);
          if (name) locs.push(name);
        }
      }
      /** @type {{id:string,title:string,url:string,company:string,location:string,postedAt?:number}} */
      const job = { id, title, url: `${cfg.base}/OpportunityDetail?opportunityId=${id.toLowerCase()}`, company: companyName, location: [...new Set(locs)].join(' · ') };
      const ms = typeof o.PostedDate === 'string' ? Date.parse(o.PostedDate) : NaN;
      if (Number.isFinite(ms) && ms > 0) job.postedAt = ms;
      jobs.push(job);
    } catch {
      skipped++;
    }
  }
  if (json.opportunities.length > 0 && jobs.length === 0) throw new Error(`ukg: ${json.opportunities.length} rows but none parsed (shape changed?)`);
  return { jobs, rawCount: json.opportunities.length, skipped, total: json.totalCount };
}

/** @param {any} entry @param {any} ctx */
function resolveMaxPages(entry, ctx) {
  const v = entry?.max_pages;
  const fromEntry = Number.isInteger(v) && v > 0 ? Math.min(v, MAX_PAGES_CAP) : DEFAULT_MAX_PAGES;
  const hint = Number(ctx?.maxPages);
  return Number.isFinite(hint) && hint > 0 ? Math.min(fromEntry, Math.floor(hint)) : fromEntry;
}

/** @type {Provider} */
export default {
  id: 'ukg',

  detect(entry) {
    try {
      const raw = entry?.careers_url || entry?.api;
      if (typeof raw !== 'string') return null;
      return { url: `${resolveConfig({ careers_url: raw }).base}/JobBoardView/LoadSearchResults` };
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry); // throws before any request
    const url = `${cfg.base}/JobBoardView/LoadSearchResults`;
    const maxPages = resolveMaxPages(entry, ctx);
    const seen = new Set();
    const all = [];
    let raw = 0;
    let skipped = 0;
    /** @type {number|null} */
    let total = null;
    let pages = 0;
    for (let page = 0; page < maxPages; page++) {
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const json = await fetchJsonWithRetry(ctx, url, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: buildSearchBody(raw),
      });
      pages = page + 1;
      const res = parsePage(json, cfg, entry.name);
      if (total === null) total = res.total;
      raw += res.rawCount;
      skipped += res.skipped;
      for (const j of res.jobs) {
        if (seen.has(j.id)) continue;
        seen.add(j.id);
        all.push(j);
      }
      if (res.rawCount === 0 || raw >= total) break;
    }
    if (skipped > 0) console.error(`⚠️  ukg: ${entry.name} skipped ${skipped} malformed rows`);
    if (total !== null && raw < total) {
      console.error(`⚠️  ukg: ${entry.name} truncated (${pages >= maxPages ? `max_pages=${maxPages}` : 'short pages'}): ${raw} of ${total} rows read`);
    }
    return all;
  },
};
