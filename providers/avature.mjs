// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
import { decodeEntities } from './_html-entities.mjs';
import { sleep } from './_http.mjs';

// Avature provider — parses the public Avature career-site job list.
// Auto-detects from a careers_url on `*.avature.net`; a branded custom domain
// that proxies Avature needs an explicit `provider: avature` + `api:` pointing
// at the Avature origin (or its /careers/SearchJobs URL).
//
//   GET {origin}/careers/SearchJobs?jobOffset=N
//
// returns a server-rendered page of <article class="article--result"> blocks.
// Avature hard-caps the page at 6 results (a jobRecordsPerPage override is
// ignored), and paginates via jobOffset in steps of 6 — so this is request-
// heavy for large boards; max_pages (default 50 → ~300 postings) bounds it and
// can be raised per entry.
//
// Pagination parameter name is `jobOffset` on classic tenants, but some branded
// tenants ignore it and page via a bare `offset` instead (e.g. jobs.siemens.com:
// `?jobOffset=6` returns page 1 unchanged, `?offset=6` advances). This is
// self-healing: we start with `jobOffset`, and if the first paginated page comes
// back identical to page 0 (every id already seen → the param is inert), we
// retry that page with the other known keys (see OFFSET_KEYS; 2026-11-11) and
// adopt whichever key actually advances.
// So a new branded tenant needs no configuration. An entry can still pin the key
// explicitly via `offset_param` (disables the auto-switch) as an escape hatch.
//
// Location isn't rendered in every tenant's list (the subtitle is Job ID /
// hire-type / posted-date); we extract it when a marker is present and leave it
// empty otherwise. postedAt comes from the "Posted DD-Mon-YYYY" subtitle.
//
// 2026-11-07 additions:
//   - Result-class match is token-based: Deloitte renders `class="article--result "`
//     (no leading `article`), which the old literal prefix missed → silent 0.
//   - Legacy layout (KPMG US, uskpmgats.avature.net/careers/SearchResults):
//     `<div class="result">` rows linking `JobDetail?jobId=N`, subtitle
//     "<Practice> - <City, ST>; <City, ST>". Parsed when no <article> rows exist.
//   - Page size is NOT always 6 (Lenovo/Deloitte/Lululemon/KPMG serve 10,
//     Bloomberg 12). The offset now advances by the number of rows the page
//     actually returned, and "short page" means shorter than page 0.
//   - Never silent-empty on a layout change: if page 0 links job/pipeline
//     detail pages but nothing parsed, fetch() throws. A `PipelineDetail` page
//     (HSBC's mycareer.hsbc.com is a talent-pipeline board, not job postings)
//     throws with that explanation.
// Bot walls seen (not bypassed): careers.cbre.com and careers.ralphlauren.com
// answer 202 with an AWS WAF JavaScript challenge (challenge.js).
//
// 2026-11-11 additions:
//   - Branded list pages are not always called SearchJobs: Siemens Energy has
//     per-country saved searches (/en_US/jobs/SearchJobsUS; its bare SearchJobs
//     302s to a 404), Enel lists US jobs under /en_US/careers/JobOpeningsUSA.
//     An explicit path whose last segment starts with Search… or JobOpenings…
//     is honoured as-is.
//   - The careers_url query string is kept (offset keys dropped) and sent on
//     every page, so an entry can use the site's own filter, e.g. TotalEnergies
//     `SearchJobs?search=United%20States` (168 US rows vs a 999+ global board).
//   - Siemens Energy rows link `/FolderDetail/<slug>/<id>` instead of JobDetail;
//     both are parsed.
//   - The pagination key is read from the page's own pager links (jobOffset,
//     folderOffset or offset — Siemens Energy only answers folderOffset). The
//     page-1 self-heal now tries each remaining key in turn.

const PAGE_SIZE = 6; // Avature serves exactly 6 results per page
const DEFAULT_MAX_PAGES = 50; // ~300 postings; override via entry.max_pages
const HARD_MAX_PAGES = 200;
// Pause between successive page requests. Avature's 6-results-per-page cap makes
// large boards request-heavy (a 999+ board is ~170 pages); firing those with no
// gap risks the tenant's WAF rate-limiting the burst. Mirrors workday's
// INTER_PAGE_DELAY_MS — only boards that paginate past page 0 pay it.
const INTER_PAGE_DELAY_MS = 250;
// Pagination keys seen across tenants. The self-heal tries the ones not in
// use, in this order, when page 1 does not advance.
const OFFSET_KEYS = ['jobOffset', 'offset', 'folderOffset'];

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** @param {import('./_types.js').PortalEntry} entry */
function resolveConfig(entry) {
  const raw = entry.api || entry.careers_url || '';
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  // Honour an explicit SearchJobs path (branded tenants may prefix a locale,
  // e.g. /en_US/searchjobs/SearchJobs); otherwise default to the classic path.
  // Legacy tenants (KPMG US) list jobs under /careers/SearchResults instead.
  // Branded saved searches (SearchJobsUS, JobOpeningsUSA) are honoured too.
  const path = u.pathname.replace(/\/+$/, '');
  const searchPath = /\/Search(?:Jobs|Results)\b/i.test(path) || /\/(?:Search|JobOpenings)[A-Za-z]*$/.test(path) ? path : '/careers/SearchJobs';
  // Keep the entry's own filter (e.g. ?search=United%20States); drop offsets,
  // which fetch() sets per page.
  const params = new URLSearchParams(u.search);
  for (const k of OFFSET_KEYS) params.delete(k);
  return { searchUrl: `${u.origin}${searchPath}`, origin: u.origin, query: params.toString() };
}

/** @param {string} s */
function clean(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// "Posted 02-May-2026" → epoch ms (UTC midnight). Undefined when absent/unparseable.
/** @param {string} block */
function parsePosted(block) {
  const m = block.match(/Posted\s+(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!m) return undefined;
  const mon = MONTHS[m[2].toLowerCase()];
  if (mon === undefined) return undefined;
  const ms = Date.UTC(Number(m[3]), mon, Number(m[1]));
  return Number.isNaN(ms) ? undefined : ms;
}

// Best-effort location: some tenants tag it with a list-item-location span or a
// map-marker glyph; most (e.g. Synopsys) render none, so this returns ''.
/** @param {string} block */
function parseLocation(block) {
  const m =
    block.match(/list-item-location[^>]*>([\s\S]*?)<\/span>/i) ||
    block.match(/class="[^"]*\blocation\b[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div|li)>/i) ||
    block.match(/glyphicon-map-marker[\s\S]{0,80}?>([^<]{2,60})</i) ||
    // TotalEnergies: <li class="list-item list-item-jobCountry">United States / US</li>
    block.match(/list-item-job(?:Location|City|Country)\b[^>]*>([\s\S]*?)<\/li>/i) ||
    block.match(/icon-address[^>]*><\/span>([^<]{2,80})</i);
  return m ? clean(m[1]) : '';
}

/** @param {string} htmlText @param {string} origin */
export function parseArticles(htmlText, origin) {
  const out = [];
  // Tenants vary the result class: Synopsys uses `article--result`, Siemens
  // appends a position index (`article--result 1`). Accept any suffix.
  // Deloitte drops the leading `article` token (`class="article--result "`), so
  // match the article--result token anywhere in the class attribute.
  // Enel and TotalEnergies render the row as <div class="article article--result">
  // (2026-11-11), whose </div> can't delimit it, so each row runs from its own
  // opening tag to the next row's (or </article> for the <article> form). The
  // class must hold the exact `article--result` token: Siemens Energy nests
  // `article--result--container` / `--actions` inside each row.
  // careers.avature.net renders `article--jobs` cards instead (upstream, 2026-09-28).
  const startRe = /<(article|div) class="(?:[^"]*\s)?article--(?:result|jobs)(?:\s[^"]*)?"/g;
  const starts = [];
  let a;
  while ((a = startRe.exec(htmlText)) !== null) starts.push({ at: a.index, tag: a[1] });
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].at : htmlText.length;
    let block = htmlText.slice(starts[i].at, end);
    if (starts[i].tag === 'article') {
      const close = block.indexOf('</article>');
      if (close >= 0) block = block.slice(0, close + '</article>'.length);
    } else if (i + 1 === starts.length) {
      block = block.slice(0, 8000); // last <div> row: don't run into the page footer
    }
    // JobDetail path may or may not sit under /careers/ (branded tenants vary),
    // so anchor on JobDetail/ itself rather than a fixed prefix. Prefer the
    // `class="link"` title anchor (most tenants); fall back to any JobDetail
    // anchor for tenants (e.g. Rohde & Schwarz) whose title link carries no
    // class. Share/mailto buttons url-encode the path (%2FJobDetail%2F) so they
    // never match the literal `/JobDetail/` and can't be mistaken for the title.
    // Links are path-style `/JobDetail/<slug>/<id>`, `/FolderDetail/<slug>/<id>`
    // or query-style `/JobDetail?jobId=<id>` (Macquarie, upstream #6477). An
    // `article--jobs` card's class="link" anchor is a "View more" button, so its
    // h3 header title anchor is tried first (upstream #4559).
    const urlM =
      block.match(/article__header__text__title[^>]*>\s*<a[^>]*href="([^"]*\/(?:Job|Folder)Detail[/?][^"]+)"[^>]*>([\s\S]*?)<\/a>/) ||
      block.match(/<a[^>]*class="link"[^>]*href="([^"]*\/(?:Job|Folder)Detail[/?][^"]+)"[^>]*>([\s\S]*?)<\/a>/) ||
      block.match(/<a[^>]*href="([^"]*\/(?:Job|Folder)Detail[/?][^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!urlM) continue;
    const title = clean(urlM[2]);
    if (!title) continue;
    let url = decodeEntities(urlM[1]);
    if (!/^https?:\/\//i.test(url)) {
      // new URL resolves root-, path- and protocol-relative hrefs like a browser;
      // a href it cannot resolve, or one with its own non-http scheme
      // (javascript:, data:, mailto:), is dropped (upstream #6971).
      try {
        url = new URL(url, origin).href;
      } catch {
        continue;
      }
      if (!/^https?:\/\//i.test(url)) continue;
    }
    const idM = url.match(/\/(?:Job|Folder)Detail\/(?:[^/?#]*\/)?(\d+)/) || url.match(/\/JobDetail\?(?:[^#]*&)?jobId=(\d+)/i);
    out.push({
      id: idM ? idM[1] : url,
      title,
      url,
      location: parseLocation(block),
      postedAt: parsePosted(block),
    });
  }
  return out;
}

// Legacy Avature layout (KPMG US): one <div class="result"> per row with the
// title anchor on `.../JobDetail?jobId=N...` and a <span> subtitle
// "<Practice> - <locations>". The tracking query (srcCat/specSrc) is dropped
// from the stored URL; jobId alone resolves the posting.
/** @param {string} htmlText @param {string} origin */
export function parseLegacyResults(htmlText, origin) {
  const out = [];
  const re = /<a href="([^"]*\/JobDetail\?jobId=(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>\s*<\/p>\s*<span[^>]*>([\s\S]*?)<\/span>/g;
  let m;
  while ((m = re.exec(htmlText)) !== null) {
    const title = clean(m[3]);
    if (!title) continue;
    const id = m[2];
    let base;
    try {
      const u = new URL(decodeEntities(m[1]), origin);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
      base = `${u.origin}${u.pathname}`;
    } catch {
      continue;
    }
    const sub = clean(m[4].replace(/&nbsp;/g, ' '));
    const dash = sub.indexOf(' - ');
    const location = dash >= 0 ? sub.slice(dash + 3).trim() : '';
    out.push({ id, title, url: `${base}?jobId=${id}`, location, postedAt: undefined });
  }
  return out;
}

/**
 * Parse one search page: modern <article> rows first, else the legacy layout.
 * @param {string} htmlText @param {string} origin
 */
export function parsePage(htmlText, origin) {
  const arts = parseArticles(htmlText, origin);
  return arts.length ? arts : parseLegacyResults(htmlText, origin);
}

/**
 * Count unencoded detail links on a page — evidence that the page DOES list
 * postings, used to turn "parsed 0" into an error instead of a silent empty.
 * @param {string} htmlText
 * @returns {{jobs: number, pipelines: number}}
 */
/** Distinct JobDetail hrefs on a page = rows the server returned (parsed or not). */
export function countJobRows(htmlText) {
  if (typeof htmlText !== 'string') return 0;
  return new Set(htmlText.match(/href="[^"]*\/(?:Job|Folder)Detail[/?][^"]*"/g) || []).size;
}

/**
 * The pagination key the page's own pager links use (most frequent of
 * OFFSET_KEYS), or null when the page has no pager links.
 * @param {string} htmlText
 * @returns {string|null}
 */
export function pagerOffsetParam(htmlText) {
  if (typeof htmlText !== 'string') return null;
  const counts = new Map();
  for (const m of htmlText.matchAll(/href="[^"]*[?&](?:amp;)?(jobOffset|folderOffset|offset)=\d+/g)) {
    counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  let best = null;
  for (const [k, n] of counts) if (best === null || n > counts.get(best)) best = k;
  return best;
}

/**
 * Upstream API (#4252): throws when a first page still carries posting-shaped
 * JobDetail links but nothing parsed — a markup change, never an empty board.
 * fetch() uses countDetailLinks for the same check (it also names pipelines).
 * @param {string} html @param {string} url
 */
export function assertParsedSomething(html, url) {
  if (!/\/JobDetail[/?][^"'\s]+/i.test(String(html ?? ''))) return;
  throw new Error(
    `avature: ${url} still contains JobDetail links but no article could be parsed — the listing markup changed`,
  );
}

/**
 * Upstream API (#4885): number of result cards on a page before parseArticles
 * drops any. Same row-start rule as parseArticles.
 * @param {string} htmlText
 */
export function countArticles(htmlText) {
  return (String(htmlText ?? '').match(/<(?:article|div) class="(?:[^"]*\s)?article--(?:result|jobs)(?:\s[^"]*)?"/g) || []).length;
}

export function countDetailLinks(htmlText) {
  const jobs = (htmlText.match(/href="[^"]*\/(?:Job|Folder)Detail[/?][^"]*"/g) || []).length;
  const pipelines = (htmlText.match(/href="[^"]*\/PipelineDetail\/[^"]*"/g) || []).length;
  return { jobs, pipelines };
}

/** @type {Provider} */
export default {
  id: 'avature',

  detect(entry) {
    const url = entry.api || entry.careers_url || '';
    if (typeof url !== 'string') return null;
    try {
      const host = new URL(url).host.toLowerCase();
      if (host === 'avature.net' || host.endsWith('.avature.net')) return { url };
    } catch {
      /* not absolute */
    }
    return null;
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry);
    if (!cfg) throw new Error(`avature: cannot resolve origin for ${entry.name}`);
    const maxPages = Math.min(
      HARD_MAX_PAGES,
      Number.isFinite(entry.max_pages) && entry.max_pages > 0 ? Number(entry.max_pages) : DEFAULT_MAX_PAGES,
    );

    // Pagination key. An explicit `offset_param` pins it (and disables the
    // auto-switch below); otherwise start with `jobOffset` and self-heal. A
    // non-string/empty override falls back to the default so a malformed entry
    // can't produce `?=N`.
    const pinned = typeof entry.offset_param === 'string' && entry.offset_param.trim();
    let offsetParam = pinned ? entry.offset_param.trim() : 'jobOffset';
    let canHeal = !pinned; // once the key is pinned, never auto-switch

    const jobs = [];
    const seen = new Set();

    const getPage = async (param, offset) => {
      const htmlText = await ctx.fetchText(`${cfg.searchUrl}?${cfg.query ? `${cfg.query}&` : ''}${param}=${offset}`, {
        redirect: 'error',
        headers: { accept: 'text/html' },
      });
      // A first page that is empty, or is the AWS WAF challenge shell (HTTP 202:
      // no body, or a ~2 KB page that only loads challenge.js), is not a board
      // with no jobs — that still renders its search page. Fail the list so the
      // caller hands it to a browser read instead of reporting zero jobs.
      if (offset === 0 && (typeof htmlText !== 'string' || !htmlText.trim())) {
        throw new Error(`avature: ${entry.name}: empty response (bot challenge) — needs a browser read`);
      }
      if (offset === 0 && htmlText.length < 20000 && /AwsWafIntegration|awsWafCookieDomainList/.test(htmlText)) {
        throw new Error(`avature: ${entry.name}: AWS WAF challenge page (bot challenge) — needs a browser read`);
      }
      const parsed = parsePage(htmlText, cfg.origin);
      if (offset === 0 && parsed.length === 0 && typeof htmlText === 'string') {
        const links = countDetailLinks(htmlText);
        if (links.jobs > 0) {
          throw new Error(`avature: ${entry.name}: page lists ${links.jobs} JobDetail links but none parsed — layout changed`);
        }
        if (links.pipelines > 0) {
          throw new Error(`avature: ${entry.name}: page lists only talent-pipeline entries (PipelineDetail), no job postings — wrong careers_url/provider`);
        }
      }
      // Server-side row count drives paging, so one unparsable card does not
      // look like a short (last) page or shift the offset.
      parsed.rows = Math.max(parsed.length, countJobRows(htmlText), countArticles(htmlText));
      parsed.pagerParam = offset === 0 ? pagerOffsetParam(htmlText) : null;
      return parsed;
    };
    // Absorb a page's articles, returning how many were not already seen.
    const absorb = (articles) => {
      let fresh = 0;
      for (const art of articles) {
        if (seen.has(art.id)) continue;
        seen.add(art.id);
        fresh++;
        jobs.push({
          title: art.title,
          url: art.url,
          company: entry.name,
          location: art.location,
          postedAt: art.postedAt,
        });
      }
      return fresh;
    };

    // Offset of the next page = rows returned so far (page size varies by
    // tenant: 6, 10, 12 …). pageSize is learned from page 0.
    let offset = 0;
    let pageSize = PAGE_SIZE;
    for (let page = 0; page < maxPages; page++) {
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
      let articles = await getPage(offsetParam, offset);
      let fresh = absorb(articles);
      // Follow the key the page's own pager uses (unless the entry pinned one).
      if (page === 0 && !pinned && articles.pagerParam) offsetParam = articles.pagerParam;

      // Self-heal: the first paginated page didn't advance — either it repeated
      // page 0 (all-dup) or came back empty because the primary key is inert
      // (some tenants echo page 0 for an unknown param, others return nothing).
      // Retry this page with each other known key; adopt the first that advances for
      // the remainder. Only on page 1 — inert pagination manifests immediately,
      // so a later non-advancing page is a genuine end-of-board, not a mismatch.
      // NOTE: fresh === 0 must be evaluated before the empty-page break below,
      // or an inert key that returns an empty page 1 would exit without healing.
      // A page whose cards were all dropped by the parser (rows > 0, nothing
      // parsed) still advanced — not a reason to heal (upstream `stalled`).
      const stalledPage = (articles.rows ?? articles.length) === 0 || (fresh === 0 && articles.length > 0);
      if (stalledPage && canHeal && page === 1) {
        canHeal = false;
        for (const alt of OFFSET_KEYS) {
          if (alt === offsetParam) continue;
          await sleep(INTER_PAGE_DELAY_MS, ctx);
          const altArticles = await getPage(alt, offset);
          const altFresh = absorb(altArticles);
          if (altFresh > 0) {
            offsetParam = alt;
            articles = altArticles;
            fresh = altFresh;
            break;
          }
        }
      }

      // Stop on an empty or repeated page. A page whose rows were all dropped
      // (non-http link, no title) still advanced, so the walk goes on (upstream).
      const rows = articles.rows ?? articles.length;
      if (rows === 0 || (fresh === 0 && articles.length > 0)) break; // empty / looped / offset ignored
      // Avature never serves fewer than PAGE_SIZE (6) rows on a non-final page
      // (seen: 6, 10, 12), so a shorter page 0 is the whole board (upstream).
      if (page === 0 && rows < PAGE_SIZE) break;
      if (page === 0) pageSize = rows;
      if (rows < pageSize) break; // last page (shorter than page 0)
      offset += rows;
    }
    return jobs;
  },
};
