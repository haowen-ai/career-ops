// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { fetchTextWithRetry } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

// Oleeo (ex-WCN, `*.tal.net`) candidate job-board provider (→ tracked_companies:).
//
// Oleeo hosts campus/graduate boards for banks and consultancies
// (bankcampuscareers.tal.net = Bank of America campus, nomuracampus.tal.net,
// moelis-careers.tal.net, …). A board is a public, server-rendered page:
//
//   GET https://{tenant}.tal.net/vx/…/candidate/jobboard/vacancy/{boardId}/adv/
//   → <table class="table solr_search_list">
//       <thead><tr><th class="comm_list_thead">Title<th …>Location …</thead>
//       <tr class="opp_14894 search_res details_row" data-oppid="14894"
//           data-title="Quantitative Strategies &amp; Data Group Summer Associate…">
//         <td class="comm_list_tbody"><a class="subject" href="https://…/opp/14894-…/en-GB">…</a></td>
//         <td class="comm_list_tbody">New York, NY</td> …
//
// Verified live 2026-11-07 on the three tenants above: the whole board is on
// one page (no pager markup; `start_index`/`page` params are ignored), columns
// vary per tenant (BofA: Program ID/Title/City; Nomura: Title/Location/
// Application Deadline; Moelis: Title/Application Deadline), and a board id
// can be an events board rather than jobs (BofA vacancy/2 = "Campus Events",
// vacancy/1 = "Global Programs") — point careers_url at the jobs board.
//
// - Host pinned to `<tenant>.tal.net`, https only, redirect:'error'.
// - An `/xf-<hex>/` path segment is a per-session token that makes the server
//   302; it is stripped before fetching. Nothing else in the path is changed.
// - No posted date on the list → postedAt omitted. Location comes from the
//   Location/City/Office column when the tenant has one (Moelis carries the
//   city only in the title).
//
// portals.yml:
//   - name: Bank of America (campus)
//     careers_url: https://bankcampuscareers.tal.net/vx/lang-en-GB/mobile-0/brand-4/candidate/jobboard/vacancy/1/adv/

const HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.tal\.net$/;
const BOARD_PATH_RE = /\/candidate\/jobboard\/vacancy\/\d+\/adv\/?$/;
const MAX_ROWS = 5000; // sanity ceiling on one page; real boards are 3-100
const TIMEOUT_MS = 30_000;

/**
 * Validate careers_url and return the board URL to fetch.
 * Throws on malformed URL, non-https, a host outside *.tal.net, or a path that
 * is not a candidate job board.
 * @param {any} entry
 */
export function resolveBoardUrl(entry) {
  const raw = entry?.api || entry?.careers_url;
  if (typeof raw !== 'string' || !raw) throw new Error('oleeo: careers_url is required');
  const u = new URL(raw);
  if (u.protocol !== 'https:') throw new Error(`oleeo: refusing non-https URL ${u.protocol}`);
  if (u.username || u.password || u.port) throw new Error('oleeo: credentials/ports in URL are not allowed');
  const host = u.hostname.toLowerCase();
  if (!HOST_RE.test(host)) throw new Error(`oleeo: host not allowed: ${host}`);
  const path = u.pathname.replace(/\/xf-[0-9a-f]+(?=\/)/gi, '');
  if (!BOARD_PATH_RE.test(path)) throw new Error(`oleeo: careers_url is not a candidate job board (…/candidate/jobboard/vacancy/N/adv/): ${u.pathname}`);
  return { url: `https://${host}${path.endsWith('/') ? path : `${path}/`}`, host };
}

/** @param {string} s */
function text(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Parse one board page.
 * - no results table: login wall / error page / redesign → throw
 * - table with zero rows → genuine empty board
 * @param {unknown} html
 * @param {string} host  the pinned board host; posting links elsewhere are rebuilt or dropped
 */
export function parseBoard(html, host) {
  if (typeof html !== 'string') throw new Error(`oleeo: unexpected board body (${typeof html})`);
  const tableStart = html.search(/<table[^>]*class="[^"]*\bsolr_search_list\b[^"]*"/i);
  if (tableStart < 0) {
    if (/\/(?:ats|candidate)\/login\b/i.test(html) && !/jobboard/i.test(html)) throw new Error('oleeo: board page is a login wall (no public vacancy list)');
    const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1];
    throw new Error(`oleeo: no vacancy table on board page${title ? ` (title: ${text(title).slice(0, 80)})` : ''}`);
  }
  const tableEnd = html.indexOf('</table>', tableStart);
  const table = html.slice(tableStart, tableEnd < 0 ? undefined : tableEnd);

  const thead = (table.match(/<thead[\s\S]*?<\/thead>/i) || [''])[0];
  const headers = [...thead.matchAll(/<th\b[^>]*>([\s\S]*?)(?=<th\b|<\/tr>|<\/thead>)/gi)].map((m) => text(m[1]).toLowerCase());
  const titleCol = headers.findIndex((h) => /title|vacancy|programme|program name|opportunity/.test(h) && !/id$/.test(h));
  const locCol = headers.findIndex((h) => /location|city|office/.test(h));

  const rows = [];
  const seen = new Set();
  let rawCount = 0;
  for (const m of table.matchAll(/<tr\b([^>]*\bdata-oppid="[^"]*"[^>]*)>([\s\S]*?)(?=<tr\b|$)/gi)) {
    rawCount++;
    if (rows.length >= MAX_ROWS) break;
    const attrs = m[1];
    const body = m[2];
    const oppId = (attrs.match(/\bdata-oppid="(\d{1,12})"/) || [])[1];
    if (!oppId || seen.has(oppId)) continue;
    const cells = [...body.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
    const link = body.match(/<a\b[^>]*class="[^"]*\bsubject\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || body.match(/<a\b[^>]*href="([^"]+)"[^>]*class="[^"]*\bsubject\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const dataTitle = (attrs.match(/\bdata-title="([^"]*)"/) || [])[1];
    const title = (dataTitle && text(dataTitle)) || (link && text(link[2])) || (titleCol >= 0 && cells[titleCol] ? text(cells[titleCol]) : '');
    if (!title) continue;
    let url = null;
    if (link) {
      try {
        const u = new URL(decodeEntities(link[1]), `https://${host}/`);
        if (u.protocol === 'https:' && u.hostname.toLowerCase() === host && /\/opp\/\d+/.test(u.pathname)) url = u.href;
      } catch {
        /* fall through */
      }
    }
    if (!url) continue;
    seen.add(oppId);
    const location = locCol >= 0 && typeof cells[locCol] === 'string' ? text(cells[locCol]) : '';
    rows.push({ id: oppId, title, url, location });
  }
  return { rows, rawCount };
}

/** @type {Provider} */
export default {
  id: 'oleeo',

  detect(entry) {
    try {
      const raw = entry?.careers_url || entry?.api;
      if (typeof raw !== 'string') return null;
      return { url: resolveBoardUrl({ careers_url: raw }).url };
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const { url, host } = resolveBoardUrl(entry); // throws before any request
    const html = await fetchTextWithRetry(ctx, url, { redirect: 'error', timeoutMs: TIMEOUT_MS, headers: { accept: 'text/html' } });
    const { rows, rawCount } = parseBoard(html, host);
    if (rawCount > MAX_ROWS) console.error(`⚠️  oleeo: ${entry.name} board has ${rawCount} rows — kept the first ${MAX_ROWS}`);
    return rows.map((r) => ({ title: r.title, url: r.url, company: entry.name, location: r.location }));
  },
};
