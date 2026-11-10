// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchTextWithRetry } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

// Taleo Business Edition (TBE) provider (→ tracked_companies:). TBE is the
// small/mid-market Taleo product on <cluster>.tbe.taleo.net — a different
// system from Taleo Enterprise (<tenant>.taleo.net/careersection, see
// taleo.mjs).
//
// careers_url shape (the public career website employers link to):
//   https://phg.tbe.taleo.net/phg01/ats/careers/v2/searchResults?org=NVRINC&cws=52
//
// The search page paginates through server-side session state ("next" links
// carry no org/cws), so it is not used. Every TBE career website also
// publishes a public RSS feed holding ALL its open requisitions in one
// response (verified live 2026-11-08, NVR: 167 items):
//   GET https://<host>/<cluster>/ats/servlet/Rss?org=<ORG>&cws=<N>
//   <item><title>…</title><link>…requisition.jsp?org=…&rid=…</link>
//     <pubDate>Fri, 06 Nov 2026 20:42:10 GMT</pubDate><taleo:reqId>38172</taleo:reqId>
//     <taleo:location>VA - Reston</taleo:location> …</item>
// Job.url is the v2 posting page built from reqId on the same host:
//   https://<host>/<cluster>/ats/careers/v2/viewRequisition?org=<ORG>&cws=<N>&rid=<reqId>
//
// Guards: host must be *.tbe.taleo.net and the path/org/cws shapes are
// validated before any request; redirects refused. A body that is not an RSS
// channel, or that is cut off (no closing </channel>, or unequal <item>
// open/close counts), throws. A malformed item is skipped and counted; a
// non-empty feed with no parsable item throws. No page loop: the single feed
// is capped at max_jobs with a truncation warning.

const HOST_RE = /^[a-z0-9]{2,20}\.tbe\.taleo\.net$/;
const PATH_RE = /^\/([a-z0-9]{2,20})\/ats\/(?:careers\/v2\/[A-Za-z]+|careers\/[A-Za-z.]+|servlet\/Rss)$/;
const ORG_RE = /^[A-Za-z0-9_-]{2,40}$/;
const CWS_RE = /^\d{1,6}$/;
const RID_RE = /^\d{1,12}$/;
const DEFAULT_MAX_JOBS = 3000;
const MAX_JOBS_CAP = 20000;

/**
 * @param {any} entry
 * @returns {{host:string, cluster:string, org:string, cws:string, feedUrl:string}}
 */
export function resolveConfig(entry) {
  const raw = entry?.careers_url || entry?.api;
  if (typeof raw !== 'string' || !raw) throw new Error('tbe: careers_url is required');
  const u = new URL(raw);
  if (u.protocol !== 'https:') throw new Error(`tbe: refusing non-https URL ${u.protocol}`);
  const host = u.hostname.toLowerCase();
  if (!HOST_RE.test(host)) throw new Error(`tbe: host not allowed: ${u.hostname} (must be <cluster>.tbe.taleo.net)`);
  if (u.username || u.password || u.port) throw new Error('tbe: credentials/port not allowed in careers_url');
  const m = PATH_RE.exec(u.pathname);
  if (!m) throw new Error(`tbe: unexpected careers_url path ${u.pathname}`);
  const org = u.searchParams.get('org') || '';
  const cws = u.searchParams.get('cws') || '';
  if (!ORG_RE.test(org)) throw new Error('tbe: careers_url needs org=<ORG>');
  if (!CWS_RE.test(cws)) throw new Error('tbe: careers_url needs cws=<number>');
  const cluster = m[1];
  const sp = new URLSearchParams({ org, cws });
  return { host, cluster, org, cws, feedUrl: `https://${host}/${cluster}/ats/servlet/Rss?${sp.toString()}` };
}

/** @param {{host:string,cluster:string,org:string,cws:string}} cfg @param {string} rid */
export function buildJobUrl(cfg, rid) {
  const sp = new URLSearchParams({ org: cfg.org, cws: cfg.cws, rid });
  return `https://${cfg.host}/${cfg.cluster}/ats/careers/v2/viewRequisition?${sp.toString()}`;
}

/** @param {string} xml @param {string} tag */
function tagText(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const m = re.exec(xml);
  if (!m) return '';
  let v = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(v);
  if (cdata) v = cdata[1];
  return decodeEntities(v.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Parse the RSS body. Throws on a non-RSS or truncated body.
 * @param {string} xml
 * @param {{host:string,cluster:string,org:string,cws:string}} cfg
 * @param {string} companyName
 */
export function parseFeed(xml, cfg, companyName) {
  if (typeof xml !== 'string' || !/<rss[\s>]/.test(xml) || !/<channel>/.test(xml)) {
    throw new Error(`tbe: response is not an RSS channel (starts: ${JSON.stringify(String(xml).slice(0, 80))})`);
  }
  if (!/<\/channel>\s*<\/rss>\s*$/.test(xml)) throw new Error('tbe: RSS feed is truncated (no closing </channel></rss>)');
  const opens = (xml.match(/<item>/g) || []).length;
  const closes = (xml.match(/<\/item>/g) || []).length;
  if (opens !== closes) throw new Error(`tbe: RSS feed is malformed (${opens} <item> vs ${closes} </item>)`);
  const jobs = [];
  let skipped = 0;
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    try {
      const it = m[1];
      const title = tagText(it, 'title');
      let rid = tagText(it, 'taleo:reqId');
      if (!RID_RE.test(rid)) {
        const link = tagText(it, 'link');
        try { rid = new URL(link).searchParams.get('rid') || ''; } catch { rid = ''; }
      }
      if (!title || !RID_RE.test(rid)) { skipped++; continue; }
      /** @type {{id:string,title:string,url:string,company:string,location:string,postedAt?:number}} */
      const job = { id: rid, title, url: buildJobUrl(cfg, rid), company: companyName, location: tagText(it, 'taleo:location') };
      const ms = Date.parse(tagText(it, 'pubDate'));
      if (Number.isFinite(ms) && ms > 0) job.postedAt = ms;
      jobs.push(job);
    } catch {
      skipped++;
    }
  }
  if (opens > 0 && jobs.length === 0) throw new Error(`tbe: ${opens} items but none parsed (shape changed?)`);
  return { jobs, rawCount: opens, skipped };
}

/** @param {any} entry */
function resolveMaxJobs(entry) {
  const v = entry?.max_jobs;
  return Number.isInteger(v) && v > 0 ? Math.min(v, MAX_JOBS_CAP) : DEFAULT_MAX_JOBS;
}

/** @type {Provider} */
export default {
  id: 'tbe',

  detect(entry) {
    try {
      const raw = entry?.careers_url || entry?.api;
      if (typeof raw !== 'string') return null;
      return { url: resolveConfig({ careers_url: raw }).feedUrl };
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry); // throws before any request
    const xml = await fetchTextWithRetry(ctx, cfg.feedUrl, { redirect: 'error', headers: { Accept: 'application/rss+xml, application/xml, text/xml' } });
    const { jobs, rawCount, skipped } = parseFeed(xml, cfg, entry.name);
    if (skipped > 0) console.error(`⚠️  tbe: ${entry.name} skipped ${skipped} of ${rawCount} malformed items`);
    const seen = new Set();
    const out = [];
    for (const j of jobs) {
      if (seen.has(j.id)) continue;
      seen.add(j.id);
      out.push(j);
    }
    const maxJobs = resolveMaxJobs(entry);
    if (out.length > maxJobs) {
      console.error(`⚠️  tbe: ${entry.name} truncated at max_jobs=${maxJobs} (${out.length} in feed)`);
      return out.slice(0, maxJobs);
    }
    return out;
  },
};
