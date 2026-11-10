// tests/providers/vizirecruiter.test.mjs — VIZI Recruiter tenant feed
// (GET https://vizi.vizirecruiter.com/{tenant}/vizis.json, one JSON array).
//
// The fixture is a trimmed live response (2026-11-08, Ahold Delhaize USA; 3 of
// 157 records). No network — ctx is stubbed.
//
// Run:  node --test tests/providers/vizirecruiter.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/vizirecruiter.mjs')).href);
const vz = mod.default;
const { resolveConfig, parseFeed, safeLink } = mod;

const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/vizirecruiter-feed.json'), 'utf8'));
const FEED = 'https://vizi.vizirecruiter.com/aholddelhaizeusa-4547/vizis.json';
const ENTRY = { name: 'Ahold Delhaize USA', careers_url: FEED };
const CFG = resolveConfig(ENTRY);

function makeCtx(bodies) {
  const calls = [];
  let i = 0;
  return {
    calls,
    sleep: async () => {},
    fetchJson: async (url, opts) => {
      calls.push({ url, opts });
      const b = bodies[i++];
      if (b instanceof Error) throw b;
      return b;
    },
  };
}

test('id', () => {
  assert.equal(vz.id, 'vizirecruiter');
});

test('resolveConfig(): feed URL and bare tenant root resolve to the same feed', () => {
  assert.deepEqual(CFG, {
    tenant: 'aholddelhaizeusa-4547',
    feedUrl: FEED,
    linkPrefix: 'https://vizi.vizirecruiter.com/aholddelhaizeusa-4547/',
  });
  assert.equal(resolveConfig({ careers_url: 'https://vizi.vizirecruiter.com/aholddelhaizeusa-4547/' }).feedUrl, FEED);
  assert.equal(resolveConfig({ careers_url: 'https://vizi.vizirecruiter.com/aholddelhaizeusa-4547' }).feedUrl, FEED);
});

test('resolveConfig()/detect(): host allowlist and path shape enforced before any request', () => {
  for (const bad of [
    'http://vizi.vizirecruiter.com/aholddelhaizeusa-4547/vizis.json',
    'https://evil.example/aholddelhaizeusa-4547/vizis.json',
    'https://vizi.vizirecruiter.com.evil.example/a/vizis.json',
    'https://other.vizirecruiter.com/a/vizis.json',
    'https://vizi.vizirecruiter.com:8443/a/vizis.json',
    'https://user:pw@vizi.vizirecruiter.com/a/vizis.json',
    'https://vizi.vizirecruiter.com/a/b/vizis.json',
    'https://vizi.vizirecruiter.com/',
    'https://vizi.vizirecruiter.com/..%2f/vizis.json',
  ]) {
    assert.throws(() => resolveConfig({ careers_url: bad }), undefined, bad);
    assert.equal(vz.detect({ careers_url: bad }), null, bad);
  }
  assert.throws(() => resolveConfig({}), /careers_url is required/);
  assert.deepEqual(vz.detect(ENTRY), { url: FEED });
  assert.equal(vz.detect(null), null);
});

test('safeLink(): only same-host, same-tenant https links', () => {
  assert.equal(safeLink('https://vizi.vizirecruiter.com/aholddelhaizeusa-4547/390020/index.html', CFG), 'https://vizi.vizirecruiter.com/aholddelhaizeusa-4547/390020/index.html');
  for (const bad of [
    'https://vizi.vizirecruiter.com/othertenant-1/390020/index.html',
    'http://vizi.vizirecruiter.com/aholddelhaizeusa-4547/390020/index.html',
    'https://evil.example/aholddelhaizeusa-4547/390020/index.html',
    'https://vizi.vizirecruiter.com/aholddelhaizeusa-4547/',
    'javascript:alert(1)',
    '',
    null,
  ]) {
    assert.equal(safeLink(bad, CFG), null, String(bad));
  }
});

test('parseFeed(): maps the live fixture to title/url/location/postedAt', () => {
  const { rows, skipped } = parseFeed(FIXTURE, CFG);
  assert.equal(skipped, 0);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    title: 'Azure Cloud Reliability Engineer III',
    url: 'https://vizi.vizirecruiter.com/aholddelhaizeusa-4547/390020/index.html',
    location: 'Salisbury, NC',
    postedAt: 1787315446910,
  });
  assert.ok(rows.slice(1).every((r) => /Intern/.test(r.title)));
});

test('parseFeed(): one bad record does not kill the batch; private records are left out', () => {
  const feed = [
    null,
    'junk',
    { title: '', link: FIXTURE[0].link },
    { title: 'Off-tenant', link: 'https://evil.example/x/1/index.html' },
    { title: 'Hidden', link: FIXTURE[1].link, config: { private: true } },
    { ...FIXTURE[2], title: 'R&amp;D Intern', issueDate: 'not-a-date' },
  ];
  const { rows, skipped, privateCount } = parseFeed(feed, CFG);
  assert.equal(skipped, 4);
  assert.equal(privateCount, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'R&D Intern');
  assert.equal(rows[0].postedAt, undefined);
});

test('parseFeed(): a non-array payload throws instead of returning []', () => {
  assert.throws(() => parseFeed({ error: 'x' }, CFG), /expected a JSON array/);
  assert.throws(() => parseFeed(null, CFG), /expected a JSON array/);
});

test('fetch(): one GET to the pinned feed with redirect:error; jobs carry the company', async () => {
  const ctx = makeCtx([FIXTURE]);
  const jobs = await vz.fetch(ENTRY, ctx);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].url, FEED);
  assert.equal(ctx.calls[0].opts.redirect, 'error');
  assert.equal(jobs.length, 3);
  assert.ok(jobs.every((j) => j.company === 'Ahold Delhaize USA'));
});

test('fetch(): a non-empty feed where nothing parses throws (shape changed)', async () => {
  const ctx = makeCtx([[{ name: 'x' }, { name: 'y' }]]);
  await assert.rejects(() => vz.fetch(ENTRY, ctx), /none parsed/);
});

test('fetch(): an empty feed is a legitimately empty board', async () => {
  assert.deepEqual(await vz.fetch(ENTRY, makeCtx([[]])), []);
});

test('fetch(): transport errors surface (no silent empty result)', async () => {
  const err = Object.assign(new Error('HTTP 403'), { status: 403 });
  await assert.rejects(() => vz.fetch(ENTRY, makeCtx([err])), /403/);
});

test('fetch(): max_jobs truncation warns', async () => {
  const msgs = [];
  const orig = console.error;
  console.error = (m) => msgs.push(String(m));
  try {
    const jobs = await vz.fetch({ ...ENTRY, max_jobs: 2 }, makeCtx([FIXTURE]));
    assert.equal(jobs.length, 2);
  } finally {
    console.error = orig;
  }
  assert.ok(msgs.some((m) => /truncated at max_jobs=2/.test(m)));
});
