import test from 'node:test';
import assert from 'node:assert/strict';
import { toCatalog, companyStatus, deniedHits } from '../scripts/export-catalog.mjs';
import { buildPortals, readNames } from '../scripts/build-portals.mjs';

const portals = {
  title_filter: { positive: ['private'] },
  location_filter: { allow: ['Somewhere'] },
  keyword_search: { terms: ['intern'] },
  tracked_companies: [
    { name: 'Acme', careers_url: 'https://acme.example/careers', provider: 'workday', facet: false, enabled: true, note: 'x' },
    { name: 'Blocked Co', careers_url: 'https://blocked.example', provider: 'browser-only', enabled: true },
    { name: 'Old Co', careers_url: 'https://old.example', enabled: false },
  ],
};

test('catalog keeps scan settings, drops personal blocks and unknown fields, sets status', () => {
  const catalog = toCatalog(portals);
  assert.deepEqual(Object.keys(catalog), ['keyword_search', 'tracked_companies']);
  assert.deepEqual(catalog.tracked_companies[0], {
    name: 'Acme', careers_url: 'https://acme.example/careers', provider: 'workday', facet: false, status: 'ok',
  });
  assert.equal(companyStatus(portals.tracked_companies[1]), 'browser');
  assert.equal(catalog.tracked_companies[2].status, 'broken');
});

test('denied patterns ignore company names but catch other text', () => {
  const text = '- name: Northwestern Mutual\n  careers_url: https://x.example\n';
  assert.deepEqual(deniedHits(text, ['Northwestern']), []);
  assert.equal(deniedHits('# user said no\n', ['\\buser\\b']).length, 1);
});

test('build picks named companies case-insensitively and keeps base settings', () => {
  const catalog = toCatalog(portals);
  const { portals: out, missing } = buildPortals(catalog, readNames('acme\n# comment\nOld Co\nacme\n'), { title_filter: { positive: ['mine'] }, tracked_companies: [{ name: 'ignored' }] });
  assert.deepEqual(missing, []);
  assert.deepEqual(out.title_filter, { positive: ['mine'] });
  assert.deepEqual(out.keyword_search, { terms: ['intern'] });
  assert.deepEqual(out.tracked_companies.map((c) => [c.name, c.enabled, 'status' in c]), [['Acme', true, false], ['Old Co', false, false]]);
});

test('build reports names missing from the catalog', () => {
  const { missing } = buildPortals(toCatalog(portals), ['Acme', 'Nope Inc']);
  assert.deepEqual(missing, ['Nope Inc']);
});
