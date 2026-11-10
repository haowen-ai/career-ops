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
