// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchJsonWithRetry } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

// VIZI Recruiter provider (→ tracked_companies:).
//
// careers_url shape: https://vizi.vizirecruiter.com/{tenant}/vizis.json
//   e.g. https://vizi.vizirecruiter.com/aholddelhaizeusa-4547/vizis.json
//   (the bare tenant root https://vizi.vizirecruiter.com/{tenant}/ is accepted
//   too and resolves to the same feed).
//
// The tenant feed is one public, no-auth JSON array holding every open posting
// (verified live 2026-11-08: Ahold Delhaize USA, 157 records in one response,
// no pagination parameters):
//   [{"title":"…","issueDate":1787315446910,"location":"Salisbury, NC",
//     "level":"Full Time","jobFamily":"…","config":{"private":false,…},
//     "link":"https://vizi.vizirecruiter.com/{tenant}/{id}/index.html", …}]
// `link` is the server-rendered public posting page (title, location and the
// full description live in its <noscript> block), so it is the Job.url.
//
// Guards: the host is pinned to vizi.vizirecruiter.com before any request,
// every record link must stay on that host under the same tenant path, a
// non-array payload throws, a bad record is skipped (and counted), and a
// non-empty feed in which no record parses throws (markup/shape change).
// There is no page loop; the single response is capped at max_jobs and a
// truncation warns.

const HOST = 'vizi.vizirecruiter.com';
const TENANT_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/i;
const DEFAULT_MAX_JOBS = 2000;
const MAX_JOBS_CAP = 20000;

/**
 * Validate careers_url and derive {tenant, feedUrl, linkPrefix}. Throws.
 * @param {any} entry
 */
export function resolveConfig(entry) {
  const raw = entry?.careers_url || entry?.api;
  if (typeof raw !== 'string' || !raw) throw new Error('vizirecruiter: careers_url is required');
  const u = new URL(raw); // throws on malformed input
  if (u.protocol !== 'https:') throw new Error(`vizirecruiter: refusing non-https URL ${u.protocol}`);
  if (u.hostname.toLowerCase() !== HOST) throw new Error(`vizirecruiter: host not allowed: ${u.hostname}`);
  if (u.username || u.password || u.port) throw new Error('vizirecruiter: credentials/port not allowed in careers_url');
  const m = u.pathname.match(/^\/([^/]+)(?:\/(?:vizis\.json)?)?$/);
  if (!m || !TENANT_RE.test(m[1])) {
    throw new Error(`vizirecruiter: careers_url must be /{tenant}/vizis.json, got ${u.pathname}`);
  }
  const tenant = m[1];
  return {
    tenant,
    feedUrl: `https://${HOST}/${tenant}/vizis.json`,
    linkPrefix: `https://${HOST}/${tenant}/`,
  };
}

/** @param {unknown} s */
function text(s) {
  return decodeEntities(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Validate a record link: https, pinned host, same tenant path. Returns the
 * normalized URL or null.
 * @param {unknown} raw @param {{linkPrefix:string}} cfg
 */
export function safeLink(raw, cfg) {
  if (typeof raw !== 'string' || !raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== HOST || u.username || u.password || u.port) return null;
  const href = `https://${HOST}${u.pathname}`;
  if (!href.startsWith(cfg.linkPrefix) || href.length === cfg.linkPrefix.length) return null;
  return href;
}

/**
 * Map the feed array to rows. Throws on a non-array payload.
 * @param {any} json @param {{linkPrefix:string}} cfg
 * @returns {{rows: Array<{title:string,url:string,location:string,postedAt?:number}>, skipped:number, privateCount:number}}
 */
export function parseFeed(json, cfg) {
  if (!Array.isArray(json)) {
    const kind = json === null ? 'null' : typeof json;
    const keys = json && typeof json === 'object' ? ` (keys: ${Object.keys(json).slice(0, 8).join(', ') || 'none'})` : '';
    throw new Error(`vizirecruiter: expected a JSON array, got ${kind}${keys}`);
  }
  const rows = [];
  let skipped = 0;
  let privateCount = 0;
  for (const rec of json) {
    try {
      if (!rec || typeof rec !== 'object') { skipped++; continue; }
      if (rec.config && rec.config.private === true) { privateCount++; continue; }
      const title = text(rec.title);
      const url = safeLink(rec.link, cfg);
      if (!title || !url) { skipped++; continue; }
      const row = { title, url, location: text(rec.location) };
      const ms = Number(rec.issueDate);
      if (Number.isFinite(ms) && ms > 0) row.postedAt = ms;
      rows.push(row);
    } catch {
      skipped++;
    }
  }
  return { rows, skipped, privateCount };
}

function resolveMaxJobs(entry) {
  const v = entry?.max_jobs;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_JOBS_CAP);
  return DEFAULT_MAX_JOBS;
}

/** @type {Provider} */
export default {
  id: 'vizirecruiter',

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
    const cfg = resolveConfig(entry); // throws before any request
    const json = await fetchJsonWithRetry(ctx, cfg.feedUrl, { redirect: 'error', headers: { accept: 'application/json' } });
    const { rows, skipped, privateCount } = parseFeed(json, cfg);
    if (json.length > 0 && rows.length === 0 && privateCount < json.length) {
      throw new Error(`vizirecruiter: ${entry?.name}: ${json.length} records but none parsed (shape changed?)`);
    }
    if (skipped > 0) {
      console.error(`⚠️  vizirecruiter: ${entry?.name} skipped ${skipped} of ${json.length} malformed records`);
    }
    const maxJobs = resolveMaxJobs(entry);
    const seen = new Set();
    const jobs = [];
    for (const row of rows) {
      if (seen.has(row.url)) continue;
      seen.add(row.url);
      const job = { title: row.title, url: row.url, company: entry.name, location: row.location };
      if (typeof row.postedAt === 'number') job.postedAt = row.postedAt;
      jobs.push(job);
    }
    if (jobs.length > maxJobs) {
      console.error(`⚠️  vizirecruiter: ${entry?.name} truncated at max_jobs=${maxJobs} (${jobs.length} in feed) — raise max_jobs on this entry for more`);
      return jobs.slice(0, maxJobs);
    }
    return jobs;
  },
};
