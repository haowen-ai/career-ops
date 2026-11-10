// tests/providers/tbe.test.mjs — Taleo Business Edition career-website RSS
// feed (GET https://<cluster>.tbe.taleo.net/<cluster>/ats/servlet/Rss?org=…&cws=…).
//
// The fixture is a trimmed live feed (2026-11-08, NVR): two real items, two
// malformed ones and one item whose id comes only from its link.
// No network — ctx is stubbed.
//
// Run:  node --test tests/providers/tbe.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/tbe.mjs')).href);
const tbe = mod.default;
const { resolveConfig, parseFeed, buildJobUrl } = mod;
const taleo = (await import(pathToFileURL(join(ROOT, 'providers/taleo.mjs')).href)).default;

const FIXTURE = readFileSync(join(ROOT, 'tests/fixtures/tbe-rss-feed.xml'), 'utf8');
const ENTRY = { name: 'NVR', careers_url: 'https://phg.tbe.taleo.net/phg01/ats/careers/v2/searchResults?org=NVRINC&cws=52' };
const CFG = resolveConfig(ENTRY);

function makeCtx(bodies) {
  const calls = [];
  let i = 0;
  return {
    calls,
    sleep: async () => {},
    fetchText: async (url, opts) => {
      calls.push({ url, opts });
      const b = bodies[i++];
      if (b instanceof Error) throw b;
      return b;
    },
  };
}

test('id, detect(), resolveConfig(): feed URL derived; allowlist enforced', () => {
  assert.equal(tbe.id, 'tbe');
  assert.equal(CFG.feedUrl, 'https://phg.tbe.taleo.net/phg01/ats/servlet/Rss?org=NVRINC&cws=52');
  assert.ok(tbe.detect(ENTRY));
  // Taleo Enterprise must not claim a TBE host, and TBE must not claim Enterprise
  assert.equal(taleo.detect?.(ENTRY) ?? null, null);
  assert.equal(tbe.detect({ careers_url: 'https://valero.taleo.net/careersection/2/jobsearch.ftl?lang=en' }), null);
  for (const bad of [
    ENTRY.careers_url.replace('https:', 'http:'),
    ENTRY.careers_url.replace('phg.tbe.taleo.net', 'phg.tbe.taleo.net.evil.example'),
    ENTRY.careers_url.replace('phg.tbe.taleo.net', 'evil.example'),
    ENTRY.careers_url.replace('org=NVRINC', 'org=bad%20org'),
    ENTRY.careers_url.replace('cws=52', 'cws=x'),
    'https://phg.tbe.taleo.net/phg01/other/path?org=NVRINC&cws=52',
  ]) {
    assert.throws(() => resolveConfig({ careers_url: bad }), Error, bad);
  }
});

test('parseFeed(): items mapped; malformed skipped; rid from link fallback', () => {
  const { jobs, rawCount, skipped } = parseFeed(FIXTURE, CFG, 'NVR');
  assert.equal(rawCount, 5);
  assert.equal(skipped, 2);
  assert.equal(jobs.length, 3);
  assert.equal(jobs[0].title, 'Mortgage Underwriting Manager');
  assert.equal(jobs[0].location, 'VA - Reston');
  assert.equal(jobs[0].url, buildJobUrl(CFG, '38172'));
  assert.equal(jobs[0].postedAt, Date.parse('Fri, 06 Nov 2026 20:42:10 GMT'));
  assert.equal(jobs[2].title, 'Link Only & Rid');
  assert.equal(jobs[2].url, 'https://phg.tbe.taleo.net/phg01/ats/careers/v2/viewRequisition?org=NVRINC&cws=52&rid=40001');
});

test('parseFeed(): non-RSS, truncated and malformed bodies throw', () => {
  assert.throws(() => parseFeed('<html>error</html>', CFG, 'x'), /not an RSS channel/);
  assert.throws(() => parseFeed(FIXTURE.slice(0, FIXTURE.length - 40), CFG, 'x'), /truncated/);
  assert.throws(() => parseFeed('<rss><channel><item><title>a</title></channel></rss>', CFG, 'x'), /malformed/);
  assert.throws(() => parseFeed('<rss><channel><item><title></title></item></channel></rss>', CFG, 'x'), /none parsed/);
  assert.deepEqual(parseFeed('<rss version="2.0"><channel><title>x</title></channel></rss>', CFG, 'x').jobs, []);
});

test('fetch(): one feed request, redirect refused, max_jobs bound, guard first', async () => {
  const ctx = makeCtx([FIXTURE]);
  const jobs = await tbe.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 3);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].url, CFG.feedUrl);
  assert.equal(ctx.calls[0].opts.redirect, 'error');
  const orig = console.error;
  const errs = [];
  console.error = (...a) => errs.push(a.join(' '));
  try {
    assert.equal((await tbe.fetch({ ...ENTRY, max_jobs: 2 }, makeCtx([FIXTURE]))).length, 2);
  } finally {
    console.error = orig;
  }
  assert.ok(errs.some((e) => /truncated at max_jobs=2/.test(e)));
  const none = makeCtx([]);
  await assert.rejects(tbe.fetch({ name: 'x', careers_url: 'https://evil.example/phg01/ats/servlet/Rss?org=A1&cws=1' }, none), /host not allowed/);
  assert.equal(none.calls.length, 0);
});
