// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchJsonWithRetry } from './_http.mjs';

// ADP Workforce Now career center provider (→ tracked_companies:).
//
// careers_url shape (the public career-center page employers link to):
//   https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html
//     ?cid=<client uuid>&ccId=<career center id, e.g. 19000101_000001>[&lang=en_US]
//
// The page is an SPA; its job list comes from a public, no-auth JSON API on
// the same host (verified live 2026-11-08, Thor Industries, 19 postings):
//   GET https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions
//       ?cid=<cid>&ccId=<ccId>&lang=en_US&locale=en_US&$top=<n>&$skip=<n>
//   → { jobRequisitions: [ { itemID, requisitionTitle, postDate,
//        requisitionLocations: [{ nameCode: { shortName: " Elkhart, IN, US" } }], … } ],
//       meta: { startSequence, totalNumber } }
// The posting page is the career-center page with &jobId=<itemID>.
//
// This is NOT the newer myjobs.adp.com "CX" career site (Casey's, Murphy
// USA, AISIN): that one loads its list from a different, unexposed backend.
//
// Guards: host + path pinned and cid/ccId validated before any request;
// redirects refused; a body without a jobRequisitions array or a numeric
// meta.totalNumber throws; malformed rows are skipped and counted, a page
// with rows but none parsed throws; paging follows raw row counts, is
// bounded by max_pages, and a final shortfall against totalNumber is
// reported as truncated.

const HOST = 'workforcenow.adp.com';
const PAGE_PATH = '/mascsr/default/mdf/recruitment/recruitment.html';
const API_PATH = '/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions';
const CID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CCID_RE = /^[0-9]{8}_[0-9]{6}$/;
const LANG_RE = /^[a-z]{2}_[A-Z]{2}$/;
const ITEM_RE = /^[A-Za-z0-9_-]{1,60}$/;
const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 50;
const MAX_PAGES_CAP = 200;
const INTER_PAGE_DELAY_MS = 300;

/**
 * Validate careers_url; returns {cid, ccId, lang}. Throws before any request.
 * @param {any} entry
 */
export function resolveConfig(entry) {
  const raw = entry?.careers_url || entry?.api;
  if (typeof raw !== 'string' || !raw) throw new Error('adpwfn: careers_url is required');
  const u = new URL(raw);
  if (u.protocol !== 'https:') throw new Error(`adpwfn: refusing non-https URL ${u.protocol}`);
  if (u.hostname.toLowerCase() !== HOST) throw new Error(`adpwfn: host not allowed: ${u.hostname}`);
  if (u.username || u.password || u.port) throw new Error('adpwfn: credentials/port not allowed in careers_url');
  if (u.pathname !== PAGE_PATH && u.pathname !== API_PATH) throw new Error(`adpwfn: careers_url must be the career-center page ${PAGE_PATH}`);
  const cid = u.searchParams.get('cid') || '';
  const ccId = u.searchParams.get('ccId') || '';
  const lang = u.searchParams.get('lang') || 'en_US';
  if (!CID_RE.test(cid)) throw new Error('adpwfn: careers_url needs cid=<uuid>');
  if (!CCID_RE.test(ccId)) throw new Error('adpwfn: careers_url needs ccId=<NNNNNNNN_NNNNNN>');
  if (!LANG_RE.test(lang)) throw new Error(`adpwfn: bad lang ${JSON.stringify(lang)}`);
  return { cid: cid.toLowerCase(), ccId, lang };
}

/** @param {{cid:string,ccId:string,lang:string}} cfg @param {number} skip */
export function buildApiUrl(cfg, skip) {
  const sp = new URLSearchParams({ cid: cfg.cid, ccId: cfg.ccId, lang: cfg.lang, locale: cfg.lang });
  return `https://${HOST}${API_PATH}?${sp.toString()}&$top=${PAGE_SIZE}&$skip=${skip}`;
}

/** @param {{cid:string,ccId:string,lang:string}} cfg @param {string} itemId */
export function buildJobUrl(cfg, itemId) {
  const sp = new URLSearchParams({ cid: cfg.cid, ccId: cfg.ccId, jobId: itemId, lang: cfg.lang });
  return `https://${HOST}${PAGE_PATH}?${sp.toString()}`;
}

/** @param {unknown} s */
function clean(s) {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Parse one API page. Throws on an unknown shape; skips malformed rows.
 * @param {any} json
 * @param {{cid:string,ccId:string,lang:string}} cfg
 * @param {string} companyName
 */
export function parsePage(json, cfg, companyName) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('adpwfn: response is not a JSON object');
  if (!Array.isArray(json.jobRequisitions)) {
    throw new Error(`adpwfn: response has no jobRequisitions array (keys: ${Object.keys(json).slice(0, 8).join(', ') || 'none'})`);
  }
  const total = json.meta?.totalNumber;
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) throw new Error(`adpwfn: meta.totalNumber is not a number (${JSON.stringify(total)})`);
  const jobs = [];
  let skipped = 0;
  for (const r of json.jobRequisitions) {
    try {
      const id = typeof r?.itemID === 'string' ? r.itemID.trim() : '';
      const title = clean(r?.requisitionTitle);
      if (!ITEM_RE.test(id) || !title) { skipped++; continue; }
      const locs = [];
      if (Array.isArray(r.requisitionLocations)) {
        for (const l of r.requisitionLocations) {
          const name = clean(l?.nameCode?.shortName) || [clean(l?.address?.cityName), clean(l?.address?.countrySubdivisionLevel1?.codeValue)].filter(Boolean).join(', ');
          if (name) locs.push(name);
        }
      }
      /** @type {{id:string,title:string,url:string,company:string,location:string,postedAt?:number}} */
      const job = { id, title, url: buildJobUrl(cfg, id), company: companyName, location: [...new Set(locs)].join(' · ') };
      const ms = typeof r.postDate === 'string' ? Date.parse(r.postDate) : NaN;
      if (Number.isFinite(ms) && ms > 0) job.postedAt = ms;
      jobs.push(job);
    } catch {
      skipped++;
    }
  }
  if (json.jobRequisitions.length > 0 && jobs.length === 0) throw new Error(`adpwfn: ${json.jobRequisitions.length} rows but none parsed (shape changed?)`);
  return { jobs, rawCount: json.jobRequisitions.length, skipped, total };
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

/** @type {Provider} */
export default {
  id: 'adpwfn',

  detect(entry) {
    try {
      const raw = entry?.careers_url || entry?.api;
      if (typeof raw !== 'string') return null;
      return { url: buildApiUrl(resolveConfig({ careers_url: raw }), 0) };
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry); // throws before any request
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
      const json = await fetchJsonWithRetry(ctx, buildApiUrl(cfg, raw), { redirect: 'error', headers: { Accept: 'application/json' } });
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
    if (skipped > 0) console.error(`⚠️  adpwfn: ${entry.name} skipped ${skipped} malformed rows`);
    if (total !== null && raw < total) {
      console.error(`⚠️  adpwfn: ${entry.name} truncated (${pages >= maxPages ? `max_pages=${maxPages}` : 'short pages'}): ${raw} of ${total} rows read`);
    }
    return all;
  },
};
