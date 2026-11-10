// tests/providers/porsche.test.mjs — Porsche careers (jobs.porsche.com → GJB search API).
// No live network: every request goes to a fake ctx.fetchJson.
import { pass, fail, results, ROOT, captureConsoleErrors } from '../helpers.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — porsche (jobs.porsche.com GJB search API)');
try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/porsche.mjs')).href);
  const po = mod.default;
  const { resolveConfig, buildSearchUrl, parseSearchResult, formatLocation, toEpochMs, jobUrl } = mod;
  const CAREERS = 'https://jobs.porsche.com/index.php?ac=search_result&search_criterion_country[]=231';
  const noSleep = async () => {};
  const check = (ok, msg, detail) => (ok ? pass(msg) : fail(`${msg} — ${detail ?? ''}`));
  const throwsWith = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

  check(po.id === 'porsche', 'porsche.id is "porsche"', po.id);

  // ── detect(): exact host pin ────────────────────────────────────────────
  check(po.detect({ careers_url: CAREERS })?.url === new URL(CAREERS).href, 'detect() claims jobs.porsche.com');
  for (const [label, entry] of [
    ['other host', { careers_url: 'https://evil.example.com/index.php' }],
    ['look-alike suffix', { careers_url: 'https://jobs.porsche.com.evil.example/' }],
    ['backend host is not a careers_url', { careers_url: 'https://porsche-beesite-production-gjb.app.beesite.de/' }],
    ['http', { careers_url: 'http://jobs.porsche.com/index.php' }],
    ['malformed', { careers_url: '::' }],
    ['null', { careers_url: null }],
    ['object', { careers_url: {} }],
    ['missing', {}],
  ]) {
    let r;
    try { r = po.detect(entry); } catch (e) { r = `threw ${e.message}`; }
    check(r === null, `detect() → null for ${label}`, JSON.stringify(r));
  }
  check(po.detect(null) === null, 'detect() → null for a null entry');

  // ── resolveConfig() ─────────────────────────────────────────────────────
  const c1 = resolveConfig({ name: 'ExampleCo', careers_url: CAREERS });
  check(JSON.stringify(c1.searchCriteria) === JSON.stringify([
    { CriterionName: 'PositionLocation.Country', CriterionValue: ['231'] },
    { CriterionName: 'PublicationChannel.Code', CriterionValue: ['12'] },
  ]), 'resolveConfig() maps search_criterion_country[] and adds the public channel 12', JSON.stringify(c1.searchCriteria));
  const c2 = resolveConfig({ careers_url: 'https://jobs.porsche.com/index.php?ac=search_result&search_criterion_country%5B%5D=231&search_criterion_entry_level%5B%5D=5&search_criterion_entry_level%5B%5D=bad&search_criterion_channel%5B%5D=88' });
  check(JSON.stringify(c2.searchCriteria) === JSON.stringify([
    { CriterionName: 'PositionLocation.Country', CriterionValue: ['231'] },
    { CriterionName: 'CareerLevel.Code', CriterionValue: ['5'] },
    { CriterionName: 'PublicationChannel.Code', CriterionValue: ['88'] },
  ]), 'resolveConfig() maps encoded [] params, ignores non-numeric values, keeps an explicit channel', JSON.stringify(c2.searchCriteria));
  check(resolveConfig({ careers_url: 'https://jobs.porsche.com/', country: 'US' }).searchCriteria[0].CriterionValue[0] === '231', 'resolveConfig() maps country: US → 231');
  check(throwsWith(() => resolveConfig({ careers_url: 'https://jobs.porsche.com/', country: 'ZZ' }), /unknown country/), 'resolveConfig() throws on an unknown country');
  check(throwsWith(() => resolveConfig({ careers_url: 'https://evil.example.com/' }), /careers_url must be/), 'resolveConfig() throws on an unpinned host');

  const u = new URL(buildSearchUrl(c1, 201));
  const data = JSON.parse(u.searchParams.get('data') || '{}');
  check(u.origin === 'https://porsche-beesite-production-gjb.app.beesite.de' && u.pathname === '/search'
    && data.SearchParameters.FirstItem === 201 && data.SearchParameters.CountItem === 100 && data.SearchCriteria.length === 2,
  'buildSearchUrl() → GET {gjb}/search?data={…}', u.href);

  // ── parsing ─────────────────────────────────────────────────────────────
  check(toEpochMs('2026-11-06') === Date.UTC(2026, 10, 6) && toEpochMs(undefined) === undefined && toEpochMs('n/a') === undefined, 'toEpochMs() is NaN-safe');
  check(formatLocation({ PositionLocation: [{ CityName: 'Atlanta', CountryName: 'United States of America' }, { CityName: 'Carson', CountryName: 'United States of America' }] })
    === 'Atlanta, United States of America / Carson, United States of America', 'formatLocation() → "City, Country" joined');
  check(jobUrl({}, { ID: '22090' }) === 'https://jobs.porsche.com/index.php?ac=jobad&id=22090', 'jobUrl() → index.php?ac=jobad&id=<id>');
  check(jobUrl({ MatchedObjectId: '7' }, {}) === 'https://jobs.porsche.com/index.php?ac=jobad&id=7', 'jobUrl() falls back to MatchedObjectId');
  check(jobUrl({}, { ID: '1&ac=evil' }) === null && jobUrl({}, { ID: '\uD800' }) === null, 'jobUrl() drops a non-numeric (or lone-surrogate) id');

  const item = (id, title, extra = {}) => ({
    MatchedObjectId: String(id),
    MatchedObjectDescriptor: {
      ID: String(id),
      PositionID: `J0000${id}`,
      PositionTitle: title,
      PositionURI: `https://jobs.porsche.com/index.php?ac=jobad&id=${id}`,
      PositionLocation: [{ CountryName: 'United States of America', CityName: 'Atlanta' }],
      PublicationStartDate: '2026-11-06',
      ...extra,
    },
  });
  const body = (items, total) => ({ LanguageCode: 'EN', SearchResult: { SearchResultCount: items.length, SearchResultCountAll: total ?? items.length, SearchResultItems: items, UserArea: { ExecutionError: 0 } } });

  const p1 = parseSearchResult(body([
    item(22090, 'Accounting Intern'),
    item(22091, 'Sales &amp; Marketing Operations Intern'),
    item(22092, '   '),
    item('abc', 'Bad id'),
    { MatchedObjectId: '5' },
    null,
  ], 46));
  check(p1.total === 46 && p1.itemCount === 6 && p1.rows.length === 2, 'parseSearchResult() reads totals and drops rows without title/id', JSON.stringify({ t: p1.total, n: p1.itemCount, r: p1.rows.length }));
  check(p1.rows[1].title === 'Sales & Marketing Operations Intern', 'titles are entity-decoded', p1.rows[1].title);
  for (const [label, b] of [['null', null], ['{}', {}], ['[]', []]]) {
    let r;
    try { r = parseSearchResult(b); } catch (e) { r = e.message; }
    check(r && Array.isArray(r.rows) && r.rows.length === 0, `parseSearchResult() → no rows for ${label}`, JSON.stringify(r));
  }
  check(throwsWith(() => parseSearchResult({ error: { code: 404, message: 'Not Found' } }), /no SearchResult; got error/), 'parseSearchResult() throws, naming the keys, on a foreign envelope');
  check(throwsWith(() => parseSearchResult({ SearchResult: { SearchResultItems: {} } }), /not an array/), 'parseSearchResult() throws when SearchResultItems is not an array');

  // ── fetch() ─────────────────────────────────────────────────────────────
  const entry = { name: 'ExampleCo', careers_url: CAREERS };
  const pageOf = (start, n, total) => body(Array.from({ length: n }, (_, i) => item(start + i, `Job ${start + i}`)), total);
  const firstOf = (url) => JSON.parse(new URL(url).searchParams.get('data')).SearchParameters.FirstItem;

  {
    const seen = [];
    const jobs = await po.fetch(entry, { sleep: noSleep, fetchJson: async (url, opts) => { seen.push({ url, opts }); return firstOf(url) === 1 ? pageOf(1, 100, 146) : pageOf(101, 46, 146); } });
    check(jobs.length === 146 && seen.length === 2, 'fetch() pages via FirstItem until the last page', `${jobs.length} / ${seen.length}`);
    check(seen.every((s) => s.opts?.redirect === 'error'), "fetch() passes redirect: 'error' on every request");
    check(seen.every((s) => new URL(s.url).hostname === 'porsche-beesite-production-gjb.app.beesite.de'), 'fetch() only calls the fixed GJB host');
    const j = jobs[0];
    check(j.title === 'Job 1' && j.url === 'https://jobs.porsche.com/index.php?ac=jobad&id=1' && j.company === 'ExampleCo'
      && j.location === 'Atlanta, United States of America' && j.postedAt === Date.UTC(2026, 10, 6), 'fetch() returns {title,url,company,location,postedAt}', JSON.stringify(j));
  }
  {
    const jobs = await po.fetch(entry, { sleep: noSleep, fetchJson: async () => body([item(1, 'A'), item(1, 'A'), item(2, 'B')]) });
    check(jobs.length === 2, 'fetch() dedups by posting URL', String(jobs.length));
  }
  {
    const jobs = await po.fetch(entry, { sleep: noSleep, fetchJson: async () => ({}) });
    check(Array.isArray(jobs) && jobs.length === 0, 'fetch() → [] on a contentless body');
  }
  {
    let calls = 0;
    let threw = false;
    try { await po.fetch({ name: 'ExampleCo', careers_url: 'https://127.0.0.1/index.php' }, { fetchJson: async () => { calls++; return {}; } }); } catch { threw = true; }
    check(threw && calls === 0, 'fetch() rejects an unpinned careers_url before any request', `threw=${threw} calls=${calls}`);
  }
  {
    let calls = 0;
    const { result: jobs, errors } = await captureConsoleErrors(() => po.fetch(entry, { sleep: noSleep, fetchJson: async () => { calls++; return pageOf(calls * 1000, 100, 9_999_999); } }));
    check(calls === 20 && jobs.length === 2000, 'fetch() stops at DEFAULT_MAX_PAGES even when the source reports more', `${calls} / ${jobs.length}`);
    check(errors.some((e) => /raise max_pages/.test(e)), 'fetch() warns "raise max_pages" when the ceiling truncated');
  }
  {
    let calls = 0;
    const { result: jobs } = await captureConsoleErrors(() => po.fetch({ ...entry, max_pages: 2 }, { sleep: noSleep, fetchJson: async () => { calls++; return pageOf(calls * 1000, 100, 9_999_999); } }));
    check(calls === 2 && jobs.length === 200, 'fetch() honours entry max_pages', `${calls}`);
    let calls2 = 0;
    const { result: j2 } = await captureConsoleErrors(() => po.fetch({ ...entry, max_jobs: 50 }, { sleep: noSleep, fetchJson: async () => { calls2++; return pageOf(calls2 * 1000, 100, 9_999_999); } }));
    check(calls2 === 1 && j2.length === 50, 'fetch() honours entry max_jobs', `${calls2} / ${j2.length}`);
  }
  {
    let calls = 0;
    const { result: jobs, errors } = await captureConsoleErrors(() => po.fetch(entry, { maxPages: 1, sleep: noSleep, fetchJson: async () => { calls++; return pageOf(1, 100, 9_999_999); } }));
    check(calls === 1 && jobs.length === 100, 'fetch() makes exactly one request under ctx.maxPages: 1', `${calls}`);
    check(!errors.some((e) => /raise max_pages/.test(e)), 'fetch() does not warn "raise max_pages" on a probe stop');
  }
  {
    const sentinel = new (class ProbeBudget extends Error {})('budget');
    let caught;
    try { await po.fetch(entry, { maxPages: 3, sleep: noSleep, fetchJson: async (url) => { if (firstOf(url) === 1) return pageOf(1, 100, 500); throw sentinel; } }); } catch (e) { caught = e; }
    check(caught === sentinel, 'fetch() propagates a ctx.fetch* rejection unwrapped while probing');
  }
  {
    let calls = 0;
    const { result: jobs, errors } = await captureConsoleErrors(() => po.fetch(entry, { sleep: noSleep, fetchJson: async (url) => {
      calls++;
      if (firstOf(url) === 1) return pageOf(1, 100, 500);
      const err = new Error('HTTP 429'); err.status = 429; throw err;
    } }));
    check(jobs.length === 100 && calls === 4, 'fetch() retries a 429 page (3 attempts) then keeps earlier pages', `${jobs.length} / ${calls}`);
    check(errors.some((e) => /stopped at page 2/.test(e)) && !errors.some((e) => /raise max_pages/.test(e)), 'fetch-error stop warns, but not "raise max_pages"', JSON.stringify(errors));
  }
  {
    let threw = false;
    try { await po.fetch(entry, { sleep: noSleep, fetchJson: async () => { const e = new Error('HTTP 403'); e.status = 403; throw e; } }); } catch { threw = true; }
    check(threw, 'fetch() throws when the first page fails');
  }
} catch (e) {
  fail(`porsche provider tests crashed: ${e.stack || e.message}`);
}

if (isMainModule(import.meta.url)) {
  const { passed, failed } = results();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}
