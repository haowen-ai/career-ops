// tests/providers/avature-layouts.test.mjs — 2026-11-07 Avature additions:
// token-based article--result match (Deloitte), legacy SearchResults layout
// (KPMG US), variable page size, and no silent empty on unparsed pages.
// Run: node --test tests/providers/avature-layouts.test.mjs  (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = await import(pathToFileURL(join(ROOT, 'providers/avature.mjs')).href);
const avature = mod.default;
const { parseArticles, parseLegacyResults, parsePage, countDetailLinks } = mod;
const legacy = readFileSync(join(ROOT, 'tests/fixtures/avature-legacy-results.html'), 'utf8');

const art = (id, cls = 'article--result ') =>
  `<article class="${cls}"><h3><a href="https://apply.example.com/en_US/careers/JobDetail/Role-${id}/${id}" class="link">Role ${id}</a></h3></article>`;

test('parseArticles accepts class="article--result " without the leading article token (Deloitte)', () => {
  const arts = parseArticles(art(374623) + art(374621, 'article article--result'), 'https://apply.example.com');
  assert.deepEqual(arts.map((a) => a.id), ['374623', '374621']);
  // a different class that merely contains the substring must not match
  assert.equal(parseArticles('<article class="article--results-header"><a href="/x/JobDetail/A/1">A</a></article>', 'https://a.example').length, 0);
});

test('parseLegacyResults parses KPMG rows, drops tracking params and empty titles', () => {
  const rows = parseLegacyResults(legacy, 'https://uskpmgats.avature.net');
  assert.deepEqual(rows.map((r) => r.id), ['139722', '139519', '139001']);
  assert.equal(rows[0].url, 'https://uskpmgats.avature.net/careers/JobDetail?jobId=139722');
  assert.equal(rows[0].location, 'Austin, TX');
  assert.equal(rows[1].url, 'https://uskpmgats.avature.net/careers/JobDetail?jobId=139519');
  assert.equal(rows[1].title, 'Actuarial Life Experienced Associate (Advisory & Audit)');
  assert.equal(rows[1].location, 'Los Angeles, CA; Denver, CO');
  assert.equal(rows[2].location, '');
  assert.equal(parsePage(legacy, 'https://uskpmgats.avature.net').length, 3);
});

test('countDetailLinks ignores url-encoded share links', () => {
  const c = countDetailLinks('<a href="https://x.example/share?u=https%3A%2F%2Fa%2FJobDetail%2Fb%2F1">s</a><a href="/c/PipelineDetail/X/2">p</a>');
  assert.deepEqual(c, { jobs: 0, pipelines: 1 });
});

test('fetch honours a /careers/SearchResults careers_url', async () => {
  const calls = [];
  const ctx = { sleep: async () => {}, fetchText: async (url) => { calls.push(url); return calls.length === 1 ? legacy : ''; } };
  const jobs = await avature.fetch({ name: 'KPMG', careers_url: 'https://uskpmgats.avature.net/careers/SearchResults' }, ctx);
  assert.equal(calls[0], 'https://uskpmgats.avature.net/careers/SearchResults?jobOffset=0');
  assert.equal(jobs.length, 3);
  assert.equal(jobs[0].company, 'KPMG');
});

test('fetch advances the offset by the observed page size (10/page)', async () => {
  const calls = [];
  const page = (from, n) => Array.from({ length: n }, (_, i) => art(from + i)).join('');
  const ctx = {
    sleep: async () => {},
    fetchText: async (url) => {
      calls.push(url);
      const off = Number(new URL(url).searchParams.get('jobOffset'));
      if (off === 0) return page(1, 10);
      if (off === 10) return page(11, 10);
      if (off === 20) return page(21, 3);
      throw new Error(`unexpected offset ${off}`);
    },
  };
  const jobs = await avature.fetch({ name: 'X', api: 'https://apply.example.com/en_US/careers/SearchJobs' }, ctx);
  assert.equal(jobs.length, 23);
  assert.deepEqual(calls.map((u) => new URL(u).searchParams.get('jobOffset')), ['0', '10', '20']);
});

test('fetch throws instead of returning [] when page 0 has detail links it cannot parse', async () => {
  const unknown = '<ul><li class="new-layout"><a href="https://a.example/careers/JobDetail/Role/9">Role</a></li></ul>';
  await assert.rejects(
    avature.fetch({ name: 'X', api: 'https://a.example/careers/SearchJobs' }, { sleep: async () => {}, fetchText: async () => unknown }),
    /JobDetail links but none parsed/,
  );
  const pipeline = '<article class="article article--result"><h3><a href="https://mycareer.example/en_GB/external/PipelineDetail/GSC/288707">GSC</a></h3></article>';
  await assert.rejects(
    avature.fetch({ name: 'HSBC', api: 'https://mycareer.example/en_GB/external/SearchJobs' }, { sleep: async () => {}, fetchText: async () => pipeline }),
    /talent-pipeline/,
  );
  // genuinely empty board stays []
  const none = await avature.fetch({ name: 'X', api: 'https://a.example/careers/SearchJobs' }, { sleep: async () => {}, fetchText: async () => '<div>0 results</div>' });
  assert.deepEqual(none, []);
});

// Regression (Codex review 2026-11-07): one unparsable card must not end paging early.
import avatureForRows from '../../providers/avature.mjs';
test('regression: a card with an empty title does not truncate later pages', async () => {
  const total = 30, size = 10;
  const card = (i) => `<article class="article article--result"><h3 class="article__header__text__title"><a class="link" href="https://x.avature.net/careers/JobDetail/Job-${i}/${i}">${i === 15 ? '' : 'Data Intern ' + i}</a></h3><div class="article__content"><span class="list-item-location">Chicago, IL, United States</span></div></article>`;
  const ctx = {
    fetchText: async (url) => {
      const off = Number(new URL(url).searchParams.get('jobOffset') || 0);
      let h = '<html><body>';
      for (let i = off + 1; i <= Math.min(off + size, total); i++) h += card(i);
      return h + '</body></html>';
    },
    sleep: async () => {},
  };
  const jobs = await avatureForRows.fetch({ name: 'X', careers_url: 'https://x.avature.net/careers/SearchJobs' }, ctx);
  assert.equal(jobs.length, 29);
});

// ── 2026-11-11: branded saved-search paths, kept query, FolderDetail rows,
// pager-driven offset key (Siemens Energy / Enel / TotalEnergies).
const { pagerOffsetParam } = mod;
// Row markup as served by jobs.siemens-energy.com/en_US/jobs/SearchJobsUS (trimmed).
const seRow = (id, title = `Role ${id}`) => `
  <article class="article article--result">
    <details class="article--result--container js-fetch-jobInfo">
      <summary class="article__header" tabindex="-1"><div class="article__header__text article__header__text--search-jobs">
        <h3 class="article__header__text__title article__header__text__title--4">
          <a class="article__header__focusable" href="https://jobs.siemens-energy.com/en_US/jobs/FolderDetail/${title.replace(/\W+/g, '-')}/${id}">
            ${title}
          </a>
          <span class="hot-job-tag">Hot Job</span>
        </h3></div></summary>
      <div class="article__content" id="jobDetail-${id}" data-job-id="${id}" data-fetched="false"></div>
    </details>
    <div class="article--result--actions">
      <a class="button button--secondary" href="https://jobs.siemens-energy.com/en_US/jobs/Login?folderId=${id}">Apply</a>
    </div>
  </article>`;
const sePager = (base, offsets) =>
  offsets.map((o) => `<a href="${base}/?folderRecordsPerPage=20&amp;folderOffset=${o}">${o / 20 + 1}</a>`).join('');

test('parseArticles reads FolderDetail rows (Siemens Energy)', () => {
  const rows = parseArticles(seRow(300397, 'Technical Project Lead – Compressor Components') + seRow(298765, 'Engineering Intern'), 'https://jobs.siemens-energy.com');
  assert.deepEqual(rows.map((r) => r.id), ['300397', '298765']);
  assert.equal(rows[0].title, 'Technical Project Lead – Compressor Components');
  assert.equal(rows[1].url, 'https://jobs.siemens-energy.com/en_US/jobs/FolderDetail/Engineering-Intern/298765');
  // the Login?folderId= apply button is not a row link
  assert.equal(countDetailLinks(seRow(1)).jobs, 1);
});

test('pagerOffsetParam picks the key the pager links use', () => {
  assert.equal(pagerOffsetParam(sePager('https://x/SearchJobsUS', [20, 40, 60])), 'folderOffset');
  assert.equal(pagerOffsetParam('<a href="/careers/SearchJobs?jobOffset=6">2</a><a href="/careers/SearchJobs?jobOffset=12">3</a>'), 'jobOffset');
  assert.equal(pagerOffsetParam('<a href="/x/SearchJobs/?offset=6">2</a>'), 'offset');
  assert.equal(pagerOffsetParam('<div>no pager</div>'), null);
  // a param that merely ends in "offset" (e.g. folderRecordsPerPage) is not a key
  assert.equal(pagerOffsetParam('<a href="/x?folderRecordsPerPage=20">a</a>'), null);
});

test('fetch keeps a SearchJobsUS path and pages with the pager key (folderOffset)', async () => {
  const base = 'https://jobs.siemens-energy.com/en_US/jobs/SearchJobsUS';
  const calls = [];
  const ctx = {
    sleep: async () => {},
    fetchText: async (url) => {
      calls.push(url);
      const u = new URL(url);
      if (u.searchParams.has('jobOffset') && u.searchParams.get('jobOffset') !== '0') return 'page 0 echoed';
      const off = Number(u.searchParams.get('folderOffset') ?? u.searchParams.get('jobOffset') ?? 0);
      const n = off === 40 ? 5 : 20;
      return Array.from({ length: n }, (_, i) => seRow(1000 + off + i)).join('') + sePager(base, [20, 40]);
    },
  };
  const jobs = await avature.fetch({ name: 'Siemens Energy', careers_url: base }, ctx);
  assert.equal(jobs.length, 45);
  assert.deepEqual(calls, [`${base}?jobOffset=0`, `${base}?folderOffset=20`, `${base}?folderOffset=40`]);
});

test('fetch keeps a JobOpeningsUSA path (Enel) and the careers_url filter query (TotalEnergies)', async () => {
  const first = async (entry) => {
    const calls = [];
    await avature.fetch(entry, { sleep: async () => {}, fetchText: async (url) => { calls.push(url); return '<html><body>no results</body></html>'; } });
    return calls[0];
  };
  assert.equal(await first({ name: 'Enel', careers_url: 'https://jobs.enel.com/en_US/careers/JobOpeningsUSA' }), 'https://jobs.enel.com/en_US/careers/JobOpeningsUSA?jobOffset=0');
  assert.equal(
    await first({ name: 'TotalEnergies', careers_url: 'https://jobs.totalenergies.com/en_US/careers/SearchJobs?search=United%20States&jobOffset=40' }),
    'https://jobs.totalenergies.com/en_US/careers/SearchJobs?search=United+States&jobOffset=0',
  );
  // a non-list path still falls back to the classic SearchJobs
  assert.equal(await first({ name: 'X', careers_url: 'https://x.avature.net/en_US/careers/Home' }), 'https://x.avature.net/careers/SearchJobs?jobOffset=0');
});

test('self-heal tries folderOffset after offset when both earlier keys are inert', async () => {
  const base = 'https://a.example/en_US/jobs/SearchJobs';
  const calls = [];
  const ctx = {
    sleep: async () => {},
    fetchText: async (url) => {
      calls.push(url);
      const f = new URL(url).searchParams.get('folderOffset');
      const off = f === null ? 0 : Number(f);
      return Array.from({ length: off === 0 ? 6 : off === 6 ? 2 : 0 }, (_, i) => art(500 + off + i, 'article article--result')).join('');
    },
  };
  const jobs = await avature.fetch({ name: 'X', api: base }, ctx);
  assert.equal(jobs.length, 8);
  assert.deepEqual(calls.map((u) => u.split('?')[1]), ['jobOffset=0', 'jobOffset=6', 'offset=6', 'folderOffset=6']);
});

// <div class="article article--result"> rows (2026-11-11 live markup, trimmed).
const enelRow = (id, title) => `
  <div class="article article--result">
    <div class="article__header"><div class="article__header__text">
      <div class="article__header__text__ref">Job ID ${id}</div>
      <h3 class="article__header__text__title article__header__text__title--6">
        <a href="https://jobs.enel.com/en_US/careers/JobDetail/${id}?team=RenewableEnergies">${title}</a>
      </h3>
      <div class="article__header__text__subtitle">
        <span class="article__header__text__subtitle--location">USA</span>
        <span class="article__header__text__subtitle--separator">|</span>
        <span class="article__header__text__subtitle--team">Renewable Energies</span>
      </div>
    </div></div>
    <div class="article__footer"><a href="https://jobs.enel.com/en_US/careers/ApplicationMethods?jobId=${id}">Apply</a></div>
  </div>`;
const totalRow = (n, id, title, country) => `
  <div class="article article--result" id="article--${n}">
    <div class="article__header"><div class="article__header__text">
      <h3 class="article__header__text__title title title--04">
        <a class="link" href="https://jobs.totalenergies.com/en_US/careers/JobDetail/${title.replace(/\W+/g, '-')}/${id}">${title}</a>
      </h3>
      <ul class="list article__header__text__subtitle">
        <li class="list-item list-item-jobCreationDate">11-11-2026</li> <li class="list-item list-item-jobCountry">${country}</li> <li class="list-item list-item-employmentType">Internship</li>
      </ul>
    </div></div>
    <div class="article__footer"></div>
  </div>`;

test('parseArticles reads <div class="article article--result"> rows (Enel, TotalEnergies)', () => {
  const enel = parseArticles(`<div class="results">${enelRow(22872, 'Renewable Technician I- Fencepost')}${enelRow(22901, 'Summer Intern')}</div><footer><span class="location">Rome</span></footer>`, 'https://jobs.enel.com');
  assert.deepEqual(enel.map((r) => [r.id, r.title, r.location]), [['22872', 'Renewable Technician I- Fencepost', 'USA'], ['22901', 'Summer Intern', 'USA']]);
  assert.equal(enel[1].url, 'https://jobs.enel.com/en_US/careers/JobDetail/22901?team=RenewableEnergies');
  const total = parseArticles(totalRow(1, 86136, 'Sales Support Advisor', 'United Kingdom') + totalRow(2, 86140, 'Engineering Intern', 'United States / US'), 'https://jobs.totalenergies.com');
  assert.deepEqual(total.map((r) => [r.id, r.title, r.location]), [['86136', 'Sales Support Advisor', 'United Kingdom'], ['86140', 'Engineering Intern', 'United States / US']]);
  // nested --container / --actions classes are not row starts
  assert.equal(parseArticles(seRow(7), 'https://jobs.siemens-energy.com').length, 1);
});

test('an empty first page (bot challenge, e.g. AWS WAF HTTP 202) fails the list instead of reporting zero jobs', async () => {
  const entry = { name: 'Delta Air Lines', provider: 'avature', careers_url: 'https://delta.avature.net/en_US/careers/SearchJobs' };
  for (const body of ['', '   \n', null]) {
    const ctx = { sleep: async () => {}, fetchText: async () => body };
    await assert.rejects(() => avatureForRows.fetch(entry, ctx), /empty response \(bot challenge\) — needs a browser read/);
  }
  const waf = '<!DOCTYPE html><html><head><script>window.awsWafCookieDomainList = [];window.gokuProps = {};</script><script src="https://x.token.awswaf.com/x/challenge.js"></script></head><body><script>AwsWafIntegration.getToken()</script></body></html>';
  await assert.rejects(() => avatureForRows.fetch(entry, { sleep: async () => {}, fetchText: async () => waf }), /AWS WAF challenge page \(bot challenge\) — needs a browser read/);
});
