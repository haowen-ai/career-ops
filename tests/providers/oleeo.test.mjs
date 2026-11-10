// tests/providers/oleeo.test.mjs — Oleeo (*.tal.net) candidate job boards.
//
// Fixtures are trimmed live pages (2026-11-07): Bank of America campus
// "Global Programs" board (Program ID/Title/City columns) and the Moelis
// "Student Opportunities" board (Title/Application Deadline, no location).
// No network is used — ctx is stubbed.
//
// Run:  node --test tests/providers/oleeo.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/oleeo.mjs')).href);
const ol = mod.default;
const { resolveBoardUrl, parseBoard } = mod;

const BOFA = readFileSync(join(ROOT, 'tests/fixtures/oleeo-bofa-board.html'), 'utf8');
const MOELIS = readFileSync(join(ROOT, 'tests/fixtures/oleeo-moelis-board.html'), 'utf8');
const BOFA_HOST = 'bankcampuscareers.tal.net';
const BOFA_URL = `https://${BOFA_HOST}/vx/lang-en-GB/mobile-0/brand-4/candidate/jobboard/vacancy/1/adv/`;
const ENTRY = { name: 'Bank of America', careers_url: BOFA_URL };

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

test('id + detect(): claims only https *.tal.net candidate job boards', () => {
  assert.equal(ol.id, 'oleeo');
  assert.deepEqual(ol.detect({ careers_url: BOFA_URL }), { url: BOFA_URL });
  for (const bad of [
    `http://${BOFA_HOST}/vx/candidate/jobboard/vacancy/1/adv/`,
    'https://evil.example/vx/candidate/jobboard/vacancy/1/adv/',
    'https://bankcampuscareers.tal.net.evil.example/vx/candidate/jobboard/vacancy/1/adv/',
    'https://nomura.tal.net/vx/lang-en-GB/xf-a2c98ab7d23a/ats/login',
    'https://x.tal.net:8443/vx/candidate/jobboard/vacancy/1/adv/',
    'nope',
    '',
  ]) {
    assert.equal(ol.detect({ careers_url: bad }), null, bad);
  }
  assert.equal(ol.detect({}), null);
  assert.equal(ol.detect({ careers_url: 5 }), null);
});

test('resolveBoardUrl(): strips the xf- session token, keeps the rest, adds trailing slash', () => {
  const r = resolveBoardUrl({ careers_url: 'https://NomuraCampus.tal.net/vx/lang-en-GB/mobile-0/appcentre-ext/brand-4/xf-3348347fc789/candidate/jobboard/vacancy/1/adv' });
  assert.equal(r.host, 'nomuracampus.tal.net');
  assert.equal(r.url, 'https://nomuracampus.tal.net/vx/lang-en-GB/mobile-0/appcentre-ext/brand-4/candidate/jobboard/vacancy/1/adv/');
  assert.throws(() => resolveBoardUrl({ careers_url: 'https://moelis-careers.tal.net/vx/candidate' }), /not a candidate job board/);
  assert.throws(() => resolveBoardUrl({}), /careers_url is required/);
});

test('parseBoard(): BofA fixture — title, same-host posting URL, City column', () => {
  const { rows, rawCount } = parseBoard(BOFA, BOFA_HOST);
  assert.equal(rawCount, 3);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    id: '15270',
    title: 'Global Investment Banking Summer Analyst Program 2028 - Energy',
    url: 'https://bankcampuscareers.tal.net/vx/lang-en-GB/mobile-0/brand-4/candidate/so/pm/1/pl/1/opp/15270-Global-Investment-Banking-Summer-Analyst-Program-2028-Energy/en-GB',
    location: 'Houston, TX',
  });
});

test('parseBoard(): Moelis fixture — no location column → empty location, entities decoded', () => {
  const { rows } = parseBoard(MOELIS, 'moelis-careers.tal.net');
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.location, '');
    assert.match(r.url, /^https:\/\/moelis-careers\.tal\.net\/.*\/opp\/\d+-/);
    assert.doesNotMatch(r.title, /&#|&amp;/);
  }
});

test('parseBoard(): login wall / missing table / non-string throw; empty table is []', () => {
  assert.throws(() => parseBoard('<html><title>Login</title><a href="/vx/ats/login">x</a></html>', BOFA_HOST), /login wall/);
  assert.throws(() => parseBoard('<html><head><title>Moved</title></head></html>', BOFA_HOST), /no vacancy table.*Moved/);
  assert.throws(() => parseBoard(null, BOFA_HOST), /unexpected board body/);
  const empty = '<table class="table solr_search_list"><thead><tr><th class="comm_list_thead">Title</th></tr></thead><tbody></tbody></table>';
  assert.deepEqual(parseBoard(empty, BOFA_HOST), { rows: [], rawCount: 0 });
});

test('parseBoard(): malformed rows are skipped, duplicates collapsed, foreign links dropped', () => {
  const row = (attrs, href, title) => `<tr class="search_res" ${attrs}><td><a class="subject" href="${href}">${title}</a></td><td>NYC</td></tr>`;
  const html = `<table class="table solr_search_list"><thead><tr><th class="comm_list_thead">Title</th><th class="comm_list_thead">Location</th></tr></thead><tbody>
    ${row('data-oppid="abc"', `https://${BOFA_HOST}/vx/candidate/so/pm/1/pl/1/opp/1-x/en-GB`, 'bad id')}
    ${row('data-oppid="2"', 'https://evil.example/vx/candidate/so/pm/1/pl/1/opp/2-x/en-GB', 'foreign host')}
    ${row('data-oppid="3"', `https://${BOFA_HOST}/vx/candidate/so/pm/1/pl/1/opp/3-x/en-GB`, '')}
    ${row('data-oppid="4"', 'javascript:alert(1)', 'js link')}
    ${row('data-oppid="5"', `https://${BOFA_HOST}/vx/candidate/so/pm/1/pl/1/opp/5-good/en-GB`, 'Good &amp; Valid')}
    ${row('data-oppid="5"', `https://${BOFA_HOST}/vx/candidate/so/pm/1/pl/1/opp/5-good/en-GB`, 'Good &amp; Valid')}
  </tbody></table>`;
  const { rows, rawCount } = parseBoard(html, BOFA_HOST);
  assert.equal(rawCount, 6);
  assert.deepEqual(rows, [{ id: '5', title: 'Good & Valid', url: `https://${BOFA_HOST}/vx/candidate/so/pm/1/pl/1/opp/5-good/en-GB`, location: 'NYC' }]);
});

test('fetch(): one request, pinned host, redirect:error, Job shape', async () => {
  const ctx = makeCtx([BOFA]);
  const jobs = await ol.fetch(ENTRY, ctx);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].url, BOFA_URL);
  assert.equal(ctx.calls[0].opts.redirect, 'error');
  assert.equal(jobs.length, 3);
  assert.deepEqual(Object.keys(jobs[0]).sort(), ['company', 'location', 'title', 'url']);
  assert.equal(jobs[0].company, 'Bank of America');
});

test('fetch(): host guard runs before any request', async () => {
  const ctx = makeCtx([BOFA]);
  await assert.rejects(ol.fetch({ name: 'x', careers_url: 'https://169.254.169.254/vx/candidate/jobboard/vacancy/1/adv/' }, ctx), /host not allowed/);
  await assert.rejects(ol.fetch({ name: 'x', careers_url: 'http://a.tal.net/vx/candidate/jobboard/vacancy/1/adv/' }, ctx), /non-https/);
  assert.equal(ctx.calls.length, 0);
});

test('fetch(): error page / transport error never becomes a silent empty', async () => {
  await assert.rejects(ol.fetch(ENTRY, makeCtx(['<html><title>Error</title></html>'])), /no vacancy table/);
  await assert.rejects(ol.fetch(ENTRY, makeCtx([Object.assign(new Error('HTTP 404'), { status: 404 })])), /HTTP 404/);
});
