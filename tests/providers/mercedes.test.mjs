// tests/providers/mercedes.test.mjs — Mercedes-Benz careers (GJB search API).
// No live network: every request goes to a fake ctx.fetchJson.
import { pass, fail, results, ROOT, captureConsoleErrors } from '../helpers.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — mercedes (jobs.mercedes-benz.com GJB search API)');
try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/mercedes.mjs')).href);
  const mb = mod.default;
  const { resolveConfig, buildSearchUrl, parseSearchResult, formatLocation, toEpochMs, COUNTRY_CODES } = mod;
  const CAREERS = 'https://jobs.mercedes-benz.com/en';
  const noSleep = async () => {};
  const check = (ok, msg, detail) => (ok ? pass(msg) : fail(`${msg} — ${detail ?? ''}`));
  const throwsWith = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

  check(mb.id === 'mercedes', 'mercedes.id is "mercedes"', mb.id);

  // ── detect(): exact host pin ────────────────────────────────────────────
  check(mb.detect({ careers_url: CAREERS })?.url === CAREERS, 'detect() claims jobs.mercedes-benz.com');
  check(!!mb.detect({ api: 'https://jobs.api.mercedes-benz.com/search' }), 'detect() claims the API host');
  for (const [label, entry] of [
    ['other host', { careers_url: 'https://evil.example.com/en' }],
    ['look-alike suffix', { careers_url: 'https://jobs.mercedes-benz.com.evil.example/en' }],
    ['subdomain of pinned host', { careers_url: 'https://x.jobs.mercedes-benz.com/en' }],
    ['http', { careers_url: 'http://jobs.mercedes-benz.com/en' }],
    ['malformed', { careers_url: 'not a url' }],
    ['null', { careers_url: null }],
    ['number', { careers_url: 42 }],
    ['missing', {}],
  ]) {
    let r;
    try { r = mb.detect(entry); } catch (e) { r = `threw ${e.message}`; }
    check(r === null, `detect() → null for ${label}`, JSON.stringify(r));
  }
  check(mb.detect(null) === null && mb.detect(undefined) === null, 'detect() → null for a null/undefined entry');

  // ── resolveConfig() ─────────────────────────────────────────────────────
  const c1 = resolveConfig({ name: 'ExampleCo', careers_url: CAREERS, country: 'US' });
  check(c1.language === 'EN' && c1.linkPrefix === '/en', 'resolveConfig() reads the locale from the /en path', JSON.stringify(c1));
  check(JSON.stringify(c1.searchCriteria) === JSON.stringify([
    { CriterionName: 'PublicationLanguage.Code', CriterionValue: ['EN'] },
    { CriterionName: 'PositionLocation.Country', CriterionValue: [475] },
  ]), 'resolveConfig() sends PublicationLanguage + country US → 475', JSON.stringify(c1.searchCriteria));
  check(COUNTRY_CODES.US === 475, 'COUNTRY_CODES.US is 475');
  const c2 = resolveConfig({ careers_url: 'https://jobs.mercedes-benz.com/de?PositionLocation.Country=329&CareerLevel.Code=19&CareerLevel.Code=x' });
  check(c2.language === 'DE' && c2.linkPrefix === '/de'
    && JSON.stringify(c2.searchCriteria.slice(1)) === JSON.stringify([
      { CriterionName: 'PositionLocation.Country', CriterionValue: [329] },
      { CriterionName: 'CareerLevel.Code', CriterionValue: [19] },
    ]), 'resolveConfig() carries the site URL filters (numeric only)', JSON.stringify(c2));
  const c3 = resolveConfig({ careers_url: 'https://jobs.mercedes-benz.com/' });
  check(c3.language === 'DE' && c3.linkPrefix === '' && c3.searchCriteria.length === 1, 'resolveConfig() root URL → site default DE, all countries', JSON.stringify(c3));
  check(resolveConfig({ careers_url: CAREERS, country: 999 }).searchCriteria[1].CriterionValue[0] === 999, 'resolveConfig() accepts a numeric country code');
  check(throwsWith(() => resolveConfig({ name: 'ExampleCo', careers_url: CAREERS, country: 'ZZ' }), /unknown country/), 'resolveConfig() throws on an unknown ISO country');
  check(throwsWith(() => resolveConfig({ careers_url: 'https://evil.example.com/en' }), /careers_url must be/), 'resolveConfig() throws on an unpinned host');

  const u = new URL(buildSearchUrl(c1, 101));
  const data = JSON.parse(u.searchParams.get('data') || '{}');
  check(u.origin === 'https://jobs.api.mercedes-benz.com' && u.pathname === '/search'
    && data.SearchParameters.FirstItem === 101 && data.SearchParameters.CountItem === 100
    && data.LanguageCode === 'EN' && data.SearchCriteria.length === 2,
  'buildSearchUrl() → GET /search?data={…} with FirstItem/CountItem', u.href);

  // ── parsing ─────────────────────────────────────────────────────────────
  check(toEpochMs('2026-11-06') === Date.UTC(2026, 10, 6) && toEpochMs('') === undefined && toEpochMs('soon') === undefined, 'toEpochMs() is NaN-safe');
  check(formatLocation({ PositionLocation: [{ CityName: 'Atlanta, GA', CountryName: 'United States' }, { CityName: 'Atlanta, GA', CountryName: 'United States' }] }) === 'Atlanta, GA, United States',
    'formatLocation() → "City, Country", deduped');

  const item = (id, pid, title, extra = {}) => ({
    MatchedObjectId: String(id),
    MatchedObjectDescriptor: {
      PositionID: pid,
      PositionTitle: title,
      PositionURI: `https://jobs.mercedes-benz.com/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id}-${pid.toUpperCase()}`,
      PositionLocation: [{ CountryName: 'United States', CityName: 'Atlanta, GA' }],
      PublicationStartDate: '2026-11-06',
      ...extra,
    },
  });
  const body = (items, total) => ({ LanguageCode: 'EN', SearchResult: { SearchResultCount: items.length, SearchResultCountAll: total ?? items.length, SearchResultItems: items, UserArea: { ExecutionError: 0 } } });

  const p1 = parseSearchResult(body([
    item(244919, 'mer0004a3t', 'Engineering Intern'),
    item(244917, 'mer0004a3t', 'Engineering Intern'), // same requisition, another publication
    item(1, 'mer1', 'R&amp;D Intern'),
    item(2, 'mer2', ''), // no title → dropped
    { MatchedObjectId: '3', MatchedObjectDescriptor: { PositionID: 'mer3', PositionTitle: 'Bad URI', PositionURI: 'https://evil.example.com/x' } }, // falls back to constructed slug
    { MatchedObjectId: 'x', MatchedObjectDescriptor: { PositionID: '', PositionTitle: 'No way to link', PositionURI: '' } }, // no URL → dropped
    { MatchedObjectId: '4', MatchedObjectDescriptor: { PositionID: 'mer4', PositionTitle: '项目 Engineer', PositionURI: 'https://jobs.mercedes-benz.com/-engineer-4-MER4' } },
    null,
  ], 9), { linkPrefix: '/en' });
  check(p1.total === 9 && p1.itemCount === 8, 'parseSearchResult() reads SearchResultCountAll + item count', JSON.stringify({ t: p1.total, n: p1.itemCount }));
  check(p1.rows.length === 5, 'parseSearchResult() drops rows without a title or URL', String(p1.rows.length));
  check(p1.rows[0].url === 'https://jobs.mercedes-benz.com/en/engineering-intern-244919-MER0004A3T', 'job URL is https://jobs.mercedes-benz.com/en/<slug>', p1.rows[0].url);
  check(p1.rows[2].title === 'R&D Intern', 'titles are entity-decoded', p1.rows[2].title);
  check(p1.rows[3].url === 'https://jobs.mercedes-benz.com/en/bad-uri-3-MER3', 'a foreign-host PositionURI is not used; slug is rebuilt', p1.rows[3].url);
  check(p1.rows[4].url === 'https://jobs.mercedes-benz.com/en/-engineer-4-MER4', 'a slug starting with "-" (CJK title) is kept', p1.rows[4].url);
  const lone = parseSearchResult(body([{ MatchedObjectId: '5', MatchedObjectDescriptor: { PositionID: 'mer5', PositionTitle: 'Lone', PositionURI: 'https://jobs.mercedes-benz.com/a\uD800b-5-MER5' } }]), { linkPrefix: '/en' });
  check(lone.rows.length === 0, 'a lone surrogate in the URI drops just that posting (no throw, no U+FFFD URL)', JSON.stringify(lone.rows));

  for (const [label, b] of [['null', null], ['{}', {}], ['[]', []]]) {
    let r;
    try { r = parseSearchResult(b, { linkPrefix: '/en' }); } catch (e) { r = e.message; }
    check(r && Array.isArray(r.rows) && r.rows.length === 0, `parseSearchResult() → no rows for ${label}`, JSON.stringify(r));
  }
  check(parseSearchResult({ SearchResult: { SearchResultItems: null } }, { linkPrefix: '' }).rows.length === 0, 'parseSearchResult() → no rows for SearchResultItems: null');
  check(throwsWith(() => parseSearchResult({ error: { code: 404 } }, { linkPrefix: '' }), /no SearchResult; got error/), 'parseSearchResult() throws, naming the keys, on a foreign envelope');
  check(throwsWith(() => parseSearchResult({ SearchResult: { SearchResultItems: 'x' } }, { linkPrefix: '' }), /not an array/), 'parseSearchResult() throws when SearchResultItems is not an array');

  // ── fetch() ─────────────────────────────────────────────────────────────
  const entry = { name: 'ExampleCo', careers_url: CAREERS, country: 'US' };
  const pageOf = (start, n, total) => body(Array.from({ length: n }, (_, i) => item(start + i, `mer${start + i}`, `Job ${start + i}`)), total);

  // Normal walk: 100 + 30, stops on the short page; redirect:'error' everywhere.
  {
    const seen = [];
    const ctx = { sleep: noSleep, fetchJson: async (url, opts) => {
      seen.push({ url, opts });
      const first = JSON.parse(new URL(url).searchParams.get('data')).SearchParameters.FirstItem;
      return first === 1 ? pageOf(1, 100, 130) : pageOf(101, 30, 130);
    } };
    const jobs = await mb.fetch(entry, ctx);
    check(jobs.length === 130 && seen.length === 2, 'fetch() pages via FirstItem until the last page', `${jobs.length} jobs / ${seen.length} calls`);
    check(seen.every((s) => s.opts?.redirect === 'error'), "fetch() passes redirect: 'error' on every request");
    check(seen.every((s) => new URL(s.url).hostname === 'jobs.api.mercedes-benz.com'), 'fetch() only calls the pinned API host');
    const j = jobs[0];
    check(j.title === 'Job 1' && j.company === 'ExampleCo' && j.location === 'Atlanta, GA, United States' && j.postedAt === Date.UTC(2026, 10, 6)
      && j.url.startsWith('https://jobs.mercedes-benz.com/en/'), 'fetch() returns {title,url,company,location,postedAt}', JSON.stringify(j));
  }

  // Dedup by PositionID across publications.
  {
    const ctx = { sleep: noSleep, fetchJson: async () => body([item(10, 'mera', 'A'), item(11, 'mera', 'A'), item(12, 'merb', 'B')]) };
    const jobs = await mb.fetch(entry, ctx);
    check(jobs.length === 2, 'fetch() dedups postings that share a PositionID', String(jobs.length));
  }

  // Empty board → [].
  {
    const jobs = await mb.fetch(entry, { sleep: noSleep, fetchJson: async () => body([], 0) });
    check(Array.isArray(jobs) && jobs.length === 0, 'fetch() → [] on an empty board');
  }

  // Host guard runs before any request.
  {
    let calls = 0;
    let threw = false;
    try { await mb.fetch({ name: 'ExampleCo', careers_url: 'https://169.254.169.254/en' }, { fetchJson: async () => { calls++; return {}; } }); } catch { threw = true; }
    check(threw && calls === 0, 'fetch() rejects an unpinned careers_url before any request', `threw=${threw} calls=${calls}`);
  }

  // DEFAULT_MAX_PAGES (20) stops an endless board, with the raise-max_pages warning.
  {
    let calls = 0;
    const { result: jobs, errors } = await captureConsoleErrors(() => mb.fetch(entry, { sleep: noSleep, fetchJson: async () => { calls++; return pageOf(calls * 1000, 100, 1_000_000); } }));
    check(calls === 20 && jobs.length === 2000, 'fetch() stops at DEFAULT_MAX_PAGES even when the source reports more', `${calls} calls / ${jobs.length} jobs`);
    check(errors.some((e) => /raise max_pages/.test(e)), 'fetch() warns "raise max_pages" when the ceiling truncated', JSON.stringify(errors));
  }

  // max_pages override and max_jobs.
  {
    let calls = 0;
    const jobs = await captureConsoleErrors(() => mb.fetch({ ...entry, max_pages: 3 }, { sleep: noSleep, fetchJson: async () => { calls++; return pageOf(calls * 1000, 100, 1_000_000); } }));
    check(calls === 3 && jobs.result.length === 300, 'fetch() honours entry max_pages', `${calls} calls`);
    let calls2 = 0;
    const j2 = await captureConsoleErrors(() => mb.fetch({ ...entry, max_jobs: 150 }, { sleep: noSleep, fetchJson: async () => { calls2++; return pageOf(calls2 * 1000, 100, 1_000_000); } }));
    check(calls2 === 2 && j2.result.length === 150, 'fetch() honours entry max_jobs', `${calls2} calls / ${j2.result.length}`);
  }

  // Probe: ctx.maxPages 1 → exactly one request, no truncation warning.
  {
    let calls = 0;
    const { result: jobs, errors } = await captureConsoleErrors(() => mb.fetch(entry, { maxPages: 1, sleep: noSleep, fetchJson: async () => { calls++; return pageOf(1, 100, 1_000_000); } }));
    check(calls === 1 && jobs.length === 100, 'fetch() makes exactly one request under ctx.maxPages: 1', `${calls} calls`);
    check(!errors.some((e) => /raise max_pages/.test(e)), 'fetch() does not warn "raise max_pages" on a probe stop');
  }

  // Probe: a ctx.fetch* rejection on page 2 propagates unwrapped.
  {
    class ProbeBudget extends Error {}
    const sentinel = new ProbeBudget('budget');
    let caught;
    try {
      await mb.fetch(entry, { maxPages: 2, sleep: noSleep, fetchJson: async (url) => {
        const first = JSON.parse(new URL(url).searchParams.get('data')).SearchParameters.FirstItem;
        if (first === 1) return pageOf(1, 100, 500);
        throw sentinel;
      } });
    } catch (e) { caught = e; }
    check(caught === sentinel, 'fetch() propagates a ctx.fetch* rejection unwrapped while probing', String(caught));
  }

  // Real scan: page-2 failure after retries keeps page 1, no raise-max_pages warning.
  {
    let calls = 0;
    const { result: jobs, errors } = await captureConsoleErrors(() => mb.fetch(entry, { sleep: noSleep, fetchJson: async (url) => {
      calls++;
      const first = JSON.parse(new URL(url).searchParams.get('data')).SearchParameters.FirstItem;
      if (first === 1) return pageOf(1, 100, 500);
      const err = new Error('HTTP 503'); err.status = 503; throw err;
    } }));
    check(jobs.length === 100 && calls === 4, 'fetch() retries a 5xx page (3 attempts) then keeps earlier pages', `${jobs.length} jobs / ${calls} calls`);
    check(errors.some((e) => /stopped at page 2/.test(e)) && !errors.some((e) => /raise max_pages/.test(e)), 'fetch-error stop warns, but not "raise max_pages"', JSON.stringify(errors));
  }

  // First-page failure → throw (dead board is not an empty board).
  {
    let threw = false;
    try { await mb.fetch(entry, { sleep: noSleep, fetchJson: async () => { const e = new Error('HTTP 404'); e.status = 404; throw e; } }); } catch { threw = true; }
    check(threw, 'fetch() throws when the first page fails');
  }
} catch (e) {
  fail(`mercedes provider tests crashed: ${e.stack || e.message}`);
}

if (isMainModule(import.meta.url)) {
  const { passed, failed } = results();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}
