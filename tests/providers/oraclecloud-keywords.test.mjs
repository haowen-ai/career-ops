// tests/providers/oraclecloud-keywords.test.mjs — keyword search on big ORC
// boards (entry.keywords + entry.keyword_min_total). No network: ctx stubbed.
//
// Run:  node --test tests/providers/oraclecloud-keywords.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/oraclecloud.mjs')).href);
const oc = mod.default;
const { buildApiUrl, normalizeKeywords, facetFilters, facetMatcher, chooseFacet } = mod;

const CAREERS = 'https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs';

function finderOf(url) { return new URL(url).searchParams.get('finder'); }
function keywordOf(url) {
  const m = finderOf(url).match(/keyword="([^"]*)"/);
  return m ? m[1] : null;
}
function filterOf(url) {
  const m = finderOf(url).match(/(selected\w+Facets?=[^,]*)/);
  return m ? m[1] : null;
}
function offsetOf(url) { return Number(finderOf(url).match(/offset=(\d+)/)?.[1] ?? 0); }

// boards: { '': total, '<term>': [ids...] or total } — ids give overlap control.
function makeCtx(boards, opts = {}) {
  const calls = [];
  return {
    calls,
    transport: 'http',
    sleep: async () => {},
    fetchText: async () => { throw new Error('unused'); },
    fetchJson: async (url) => {
      calls.push(url);
      const kw = keywordOf(url) ?? '';
      const filter = filterOf(url);
      const board = filter ? (boards[filter] ?? 0) : (boards[kw] ?? 0);
      const ids = Array.isArray(board) ? board : Array.from({ length: board }, (_, i) => `${kw || 'all'}-${i}`);
      const offset = offsetOf(url);
      const slice = offset >= (opts.offsetCap ?? Infinity) ? [] : ids.slice(offset, offset + 200);
      const item = { requisitionList: slice.map((id) => ({ Id: id, Title: `Role ${id}` })) };
      if (!opts.noTotal) item.TotalJobsCount = opts.offsetCap && offset >= opts.offsetCap ? 0 : ids.length;
      if (!kw && !filter && opts.facets) Object.assign(item, opts.facets);
      return { items: [item] };
    },
  };
}

test('buildApiUrl puts keyword in the finder only, quoted and encoded', () => {
  const site = { host: 'acme.fa.us2.oraclecloud.com', siteNumber: 'CX_1' };
  const url = buildApiUrl(site, 200, 200, 'summer analyst, co-op');
  const u = new URL(url);
  assert.equal(u.searchParams.get('keyword'), null);
  assert.match(u.searchParams.get('finder'), /,keyword="summer analyst, co-op"$/);
  assert.ok(url.endsWith(',keyword=%22summer%20analyst%2C%20co-op%22&limit=200&offset=200'));
  assert.equal(buildApiUrl(site, 0, 200), buildApiUrl(site, 0, 200, null));
  assert.ok(!buildApiUrl(site, 0, 200).includes('keyword'));
});

test('normalizeKeywords: absent/empty/false → [], trims and dedupes', () => {
  assert.deepEqual(normalizeKeywords(undefined), []);
  assert.deepEqual(normalizeKeywords(false), []);
  assert.deepEqual(normalizeKeywords([]), []);
  assert.deepEqual(normalizeKeywords([' intern ', 'Intern', '', 3, 'co-op']), ['intern', 'co-op']);
});

test('keywords absent / false → unchanged full fetch, no marker', async () => {
  for (const keywords of [undefined, [], false]) {
    const ctx = makeCtx({ '': 450 });
    const jobs = await oc.fetch({ name: 'Acme', careers_url: CAREERS, keywords }, ctx);
    assert.equal(jobs.length, 450);
    assert.equal(ctx.calls.length, 3);
    assert.ok(ctx.calls.every((u) => keywordOf(u) === null));
    assert.equal(jobs.keywordSearch, undefined);
    assert.equal(jobs.truncated, undefined);
  }
});

test('board total ≤ keyword_min_total → full fetch reusing page 0, no keyword requests', async () => {
  const ctx = makeCtx({ '': 450, intern: 5 });
  const jobs = await oc.fetch({ name: 'Acme', careers_url: CAREERS, keywords: ['intern'], keyword_min_total: 1000 }, ctx);
  assert.equal(jobs.length, 450);
  assert.equal(ctx.calls.length, 3); // page 0 not re-fetched
  assert.ok(ctx.calls.every((u) => keywordOf(u) === null));
  assert.equal(jobs.keywordSearch, undefined);
});

test('board total > keyword_min_total → one walk per term, merged, deduped, marker set', async () => {
  const internIds = Array.from({ length: 250 }, (_, i) => `I${i}`); // 2 pages
  const coopIds = ['C1', 'I0', 'I1', 'C2']; // overlaps with intern
  const ctx = makeCtx({ '': 5000, intern: internIds, 'co-op': coopIds, campus: [] });
  const jobs = await oc.fetch(
    { name: 'Acme', careers_url: CAREERS, keywords: ['intern', 'co-op', 'campus'], keyword_min_total: 1000 }, ctx);
  // 1 unfiltered probe + intern 2 pages + co-op 1 + campus 1
  assert.equal(ctx.calls.length, 5);
  assert.equal(keywordOf(ctx.calls[0]), null);
  assert.deepEqual(ctx.calls.slice(1).map(keywordOf), ['intern', 'intern', 'co-op', 'campus']);
  assert.equal(jobs.length, 252);
  assert.equal(jobs[0].url.endsWith('/job/I0'), true);
  assert.deepEqual(jobs.slice(-2).map((j) => j.title), ['Role C1', 'Role C2']);
  assert.deepEqual(Object.keys(jobs[0]).sort(), ['company', 'location', 'title', 'url']);
  assert.deepEqual(jobs.keywordSearch, { mode: 'keywords', terms: 3, boardTotal: 5000, perTerm: { intern: 250, 'co-op': 4, campus: 0 } });
  assert.equal(jobs.truncated, undefined);
});

test('a term hitting the page cap → truncated', async () => {
  const ctx = makeCtx({ '': 50000, intern: 900, 'co-op': 3 });
  const jobs = await oc.fetch(
    { name: 'Acme', careers_url: CAREERS, keywords: ['intern', 'co-op'], keyword_min_total: 1000, max_pages: 2 }, ctx);
  assert.equal(jobs.keywordSearch.perTerm.intern, 400);
  assert.equal(jobs.length, 403);
  assert.equal(jobs.truncated, true);
});

test('server-side offset cap (empty page before TotalJobsCount) → truncated', async () => {
  const ctx = makeCtx({ '': 50000, intern: 700 }, { offsetCap: 400 });
  const jobs = await oc.fetch(
    { name: 'Acme', careers_url: CAREERS, keywords: ['intern'], keyword_min_total: 1000 }, ctx);
  assert.equal(jobs.length, 400);
  assert.equal(jobs.truncated, true);
});

test('exactly filling the cap with nothing left is not truncated', async () => {
  const ctx = makeCtx({ '': 50000, intern: 400 });
  const jobs = await oc.fetch(
    { name: 'Acme', careers_url: CAREERS, keywords: ['intern'], keyword_min_total: 1000, max_pages: 2 }, ctx);
  assert.equal(jobs.length, 400);
  assert.equal(jobs.truncated, undefined);
});

test('unknown board total with keywords → keyword search', async () => {
  const ctx = makeCtx({ '': 10, intern: 2 }, { noTotal: true });
  const jobs = await oc.fetch({ name: 'Acme', careers_url: CAREERS, keywords: ['intern'], keyword_min_total: 1000 }, ctx);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.keywordSearch, { mode: 'keywords', terms: 1, boardTotal: null, perTerm: { intern: 2 } });
});

test('keyword_min_total absent + facet:false → keyword search unconditionally, no unfiltered probe', async () => {
  const ctx = makeCtx({ '': 10, intern: 2 });
  const jobs = await oc.fetch({ name: 'Acme', careers_url: CAREERS, keywords: ['intern'], facet: false }, ctx);
  assert.equal(ctx.calls.length, 1);
  assert.equal(keywordOf(ctx.calls[0]), 'intern');
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.keywordSearch, { mode: 'keywords', terms: 1, boardTotal: null, perTerm: { intern: 2 } });
});

// Facet lists shaped like the live Kroger / Marriott responses (trimmed).
const FACETS = {
  categoriesFacet: [
    { Id: 300000120365216, Name: 'Food and Beverage & Culinary', TotalCount: 5039 },
    { Id: 300000120365195, Name: 'Management Development Programs/Interns', TotalCount: 30 },
  ],
  titlesFacet: [{ Id: 'KR_HR_JF_INTERN', Name: 'Intern', TotalCount: 2 }, { Id: '10', Name: 'Team Member', TotalCount: 6000 }],
  organizationsFacet: [{ Id: 1, Name: 'Marriott International, Inc.', TotalCount: 35 }, { Id: 7, Name: 'Intern', TotalCount: 4 }],
  workLocationsFacet: [{ Id: 300000122377345, Name: 'Marriott International HQ', TotalCount: 111 }],
  locationsFacet: [{ Id: 9, Name: 'University Park, PA', TotalCount: 4 }],
  flexFieldsFacet: [
    { Name: 'AttributeChar4', Label: 'Line of Business', values: [{ Id: 'Grocery Retail', Name: 'Grocery Retail', TotalCount: 10 }, { Id: 'Internships', Name: 'Internships', TotalCount: 6 }, { Id: 'Campus', Name: 'Campus', TotalCount: 3 }] },
    { Name: 'StoreLocation', Label: 'Store Location', values: [{ Id: 'UP', Name: 'University Park', TotalCount: 1 }] },
  ],
};
const F_CAT = 'selectedCategoriesFacet=300000120365195';
const F_ORG = 'selectedOrganizationsFacet=7';
const F_FLEX = 'selectedFlexFieldsFacets="AttributeChar4|Internships;Campus"';

test('facetFilters: one candidate per eligible facet, all its matching values; titles/location-like facets never', () => {
  const g = facetFilters(FACETS);
  assert.deepEqual(g.map((x) => x.name), ['categories', 'organizations', 'flex:AttributeChar4 (Line of Business)']);
  assert.deepEqual(g.map((x) => x.values), [['Management Development Programs/Interns'], ['Intern'], ['Internships', 'Campus']]);
  assert.deepEqual(g.map((x) => x.count), [30, 4, 9]);
  assert.deepEqual(g.map((x) => x.preferred), [true, false, false]);
  assert.equal(g[0].filter, F_CAT);
  assert.equal(g[2].filter, 'selectedFlexFieldsFacets=%22AttributeChar4%7CInternships%3BCampus%22');
  assert.deepEqual(facetFilters({ categoriesFacet: [{ Id: 1, Name: 'Stores', TotalCount: 9 }] }), []);
  assert.deepEqual(facetFilters(null), []);
});

test('facet with more than 200 values is skipped (built-in and flex)', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ Id: `V${i}`, Name: `Family ${i}`, TotalCount: 5 }));
  const item = {
    categoriesFacet: [...many, { Id: 'I', Name: 'Intern', TotalCount: 3 }],
    flexFieldsFacet: [{ Name: 'AttributeChar2', Label: 'Job Type', values: [...many, { Id: 'Intern', Name: 'Intern', TotalCount: 3 }] }],
  };
  assert.deepEqual(facetFilters(item), []);
  item.categoriesFacet = item.categoriesFacet.slice(1); // exactly 200 → eligible
  assert.deepEqual(facetFilters(item).map((g) => g.name), ['categories']);
});

test('chooseFacet: preferred (type/category/level/function) first, then fewest matching jobs > 0, one facet only', () => {
  const c = (name, count, preferred) => ({ name, count, preferred, values: [], filter: '', label: '' });
  assert.equal(chooseFacet([c('organizations', 4, false), c('categories', 30, true), c('flex:X (Job Type)', 12, true)]).name, 'flex:X (Job Type)');
  assert.equal(chooseFacet([c('organizations', 4, false), c('flex:Y (Line of Business)', 9, false)]).name, 'organizations');
  assert.equal(chooseFacet([c('categories', 0, true), c('organizations', 4, false)]).name, 'organizations');
  assert.equal(chooseFacet([]), null);
  // the shared exclusion list applies to flex names AND labels
  const g = facetFilters({ flexFieldsFacet: [
    { Name: 'AttributeChar9', Label: 'Store Location', values: [{ Id: 'U', Name: 'University Park', TotalCount: 2 }] },
    { Name: 'AttributeChar3', Label: 'City', values: [{ Id: 'C', Name: 'Campus', TotalCount: 2 }] },
    { Name: 'AttributeChar5', Label: 'Brand', values: [{ Id: 'S', Name: 'Student Living', TotalCount: 2 }] },
  ] });
  assert.deepEqual(g, []);
});

test('facet matcher: contract and master\'s values in, internal/international out, all matches of a facet merged', () => {
  const item = {
    categoriesFacet: [
      { Id: 'A', Name: 'Contract', TotalCount: 5 },
      { Id: 'B', Name: "Master's Program", TotalCount: 4 },
      { Id: 'C', Name: 'Internal Audit', TotalCount: 9 },
      { Id: 'D', Name: 'International Sales', TotalCount: 9 },
      { Id: 'E', Name: 'Co-op', TotalCount: 2 },
      { Id: 'F', Name: 'Early Talent', TotalCount: 3 },
      { Id: 'G', Name: 'Graduate', TotalCount: 3 },
      { Id: 'H', Name: 'Campus Hire', TotalCount: 3 },
      { Id: 'I', Name: 'Apprenticeship', TotalCount: 1 }, // "apprentice" + plural only → not matched (like internship vs intern)
      { Id: 'J', Name: 'Students', TotalCount: 1 },
    ],
  };
  const g = facetFilters(item);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].values, ['Contract', "Master's Program", 'Co-op', 'Early Talent', 'Graduate', 'Campus Hire', 'Students']);
  assert.equal(g[0].filter, 'selectedCategoriesFacet=A%3BB%3BE%3BF%3BG%3BH%3BJ');
});

test('student facet available → ONE facet query (preferred category), no keyword requests, marker mode=facet', async () => {
  const ctx = makeCtx({ '': 5000, [F_CAT]: ['A', 'B', 'C'], [F_ORG]: ['D'], [F_FLEX]: ['E'], intern: 99 }, { facets: FACETS });
  const jobs = await oc.fetch({ name: 'Acme', careers_url: CAREERS, keywords: ['intern', 'co-op'], keyword_min_total: 1000 }, ctx);
  assert.ok(ctx.calls.every((u) => keywordOf(u) === null));
  assert.ok(new URL(ctx.calls[0]).searchParams.get('expand').includes('flexFieldsFacet.values'));
  assert.deepEqual(ctx.calls.slice(1).map(filterOf), [F_CAT]);
  assert.deepEqual(jobs.map((j) => j.title), ['Role A', 'Role B', 'Role C']);
  assert.equal(jobs.keywordSearch.mode, 'facet');
  assert.equal(jobs.keywordSearch.boardTotal, 5000);
  assert.deepEqual(jobs.keywordSearch.facet, { name: 'categories', values: ['Management Development Programs/Interns'] });
  assert.equal(jobs.truncated, undefined);
});

test('no preferred facet → fewest-jobs facet, all its values in one query (flex OR syntax)', async () => {
  const facets = { organizationsFacet: [{ Id: 7, Name: 'Intern', TotalCount: 40 }], flexFieldsFacet: FACETS.flexFieldsFacet };
  const ctx = makeCtx({ '': 5000, [F_ORG]: ['D'], [F_FLEX]: ['E', 'F'] }, { facets });
  const jobs = await oc.fetch({ name: 'Acme', careers_url: CAREERS, keywords: ['intern'], keyword_min_total: 1000 }, ctx);
  assert.deepEqual(ctx.calls.slice(1).map(filterOf), [F_FLEX]);
  assert.deepEqual(jobs.keywordSearch.facet, { name: 'flex:AttributeChar4 (Line of Business)', values: ['Internships', 'Campus'] });
  assert.equal(jobs.length, 2);
});

test('facet query hitting the page cap → truncated', async () => {
  const ctx = makeCtx({ '': 5000, [F_CAT]: 500 }, { facets: { categoriesFacet: FACETS.categoriesFacet } });
  const jobs = await oc.fetch({ name: 'Acme', careers_url: CAREERS, keywords: ['intern'], keyword_min_total: 1000, max_pages: 2 }, ctx);
  assert.equal(jobs.keywordSearch.mode, 'facet');
  assert.equal(jobs.length, 400);
  assert.equal(jobs.truncated, true);
});

test('no matching facet value (only titles / location-like facets match) → keyword fallback', async () => {
  const ctx = makeCtx({ '': 5000, intern: 2 }, { facets: {
    categoriesFacet: [{ Id: 1, Name: 'Stores', TotalCount: 4999 }],
    titlesFacet: FACETS.titlesFacet,
    workLocationsFacet: FACETS.workLocationsFacet,
    flexFieldsFacet: [FACETS.flexFieldsFacet[1]],
  } });
  const jobs = await oc.fetch({ name: 'Acme', careers_url: CAREERS, keywords: ['intern'], keyword_min_total: 1000 }, ctx);
  assert.ok(ctx.calls.every((u) => filterOf(u) === null));
  assert.equal(jobs.length, 2);
  assert.equal(jobs.keywordSearch.mode, 'keywords');
});

test('chosen facet returns nothing → keyword fallback (no second facet tried)', async () => {
  const ctx = makeCtx({ '': 5000, [F_CAT]: [], [F_ORG]: ['D'], intern: 2 }, { facets: FACETS });
  const jobs = await oc.fetch({ name: 'Acme', careers_url: CAREERS, keywords: ['intern'], keyword_min_total: 1000 }, ctx);
  assert.deepEqual(ctx.calls.slice(1).map((u) => filterOf(u) || keywordOf(u)), [F_CAT, 'intern']);
  assert.equal(jobs.length, 2);
  assert.equal(jobs.keywordSearch.mode, 'keywords');
});

test('entry.facet:false → keywords even when a student facet exists', async () => {
  const ctx = makeCtx({ '': 5000, [F_CAT]: ['X'], intern: 2 }, { facets: FACETS });
  const jobs = await oc.fetch({ name: 'Acme', careers_url: CAREERS, keywords: ['intern'], keyword_min_total: 1000, facet: false }, ctx);
  assert.ok(ctx.calls.every((u) => filterOf(u) === null));
  assert.ok(!new URL(ctx.calls[0]).searchParams.get('expand').includes('flexFieldsFacet'));
  assert.equal(jobs.keywordSearch.mode, 'keywords');
  assert.equal(jobs.length, 2);
});

test('health probe (ctx.maxPages) ignores keywords and facets: unfiltered page only, no marker', async () => {
  const ctx = makeCtx({ '': 5000, [F_CAT]: ['X'], intern: 2 }, { facets: FACETS });
  ctx.maxPages = 1;
  const jobs = await oc.fetch({ name: 'Acme', careers_url: CAREERS, keywords: ['intern'], keyword_min_total: 1000 }, ctx);
  assert.equal(ctx.calls.length, 1);
  assert.equal(keywordOf(ctx.calls[0]), null);
  assert.equal(filterOf(ctx.calls[0]), null);
  assert.equal(jobs.length, 200);
  assert.equal(jobs.keywordSearch, undefined);
  assert.equal(jobs.truncated, undefined);
});

test('entry.facet_values is a word list: escaped, whole-word, plural/\'s, no regex; internal/international excluded; 200-char cap', async () => {
  // defaults
  const d = facetMatcher(undefined);
  for (const ok of ['Intern', 'Interns', 'Internships', 'Co-op', 'Co op', 'Coop', 'Students', 'Contract', "Master's Program", 'Masters',
    'Graduate Programme', 'Early Career', 'Early-Talent', 'Campus Hire', 'University Relations', 'Apprentices']) {
    assert.equal(d.test(ok), true, ok);
  }
  for (const no of ['Internal Audit', 'International Sales', 'Mastering', 'Contracting', 'Graduated Pay', 'Campuses2', 'Apprenticeship', 'Stores']) {
    assert.equal(d.test(no), false, no);
  }
  assert.deepEqual(facetMatcher([]), d);
  assert.deepEqual(facetMatcher('intern|co-?op'), d); // a string is not a list → default
  // configured words are literal, never regex
  const m = facetMatcher(['C++ (Senior)', 'a.b', 'Seasonal']);
  assert.equal(m.test('Roles: C++ (Senior)'), true);
  assert.equal(m.test('a.b'), true);
  assert.equal(m.test('axb'), false);
  assert.equal(m.test('seasonals'), true);
  assert.equal(m.test('Intern'), false);
  // internal/international excluded even when the list is just "intern"
  const facets = {
    categoriesFacet: [{ Id: 'T1', Name: 'Intern', TotalCount: 2 }, { Id: 'T2', Name: 'Seasonal', TotalCount: 3 },
      { Id: 'T3', Name: `${'x'.repeat(200)} Intern`, TotalCount: 1 }],
    organizationsFacet: [{ Id: 1, Name: 'Marriott International, Inc.', TotalCount: 35 }, { Id: 2, Name: 'Internal Audit', TotalCount: 4 }],
  };
  assert.deepEqual(facetFilters(facets, facetMatcher(['intern'])).map((g) => g.values), [['Intern']]);
  // fetch honours the configured list
  const F_SEASONAL = 'selectedCategoriesFacet=T2';
  const ctx = makeCtx({ '': 5000, [F_SEASONAL]: ['S1', 'S2'], 'selectedCategoriesFacet=T1': ['X'] }, { facets });
  const jobs = await oc.fetch({ name: 'Acme', careers_url: CAREERS, keywords: ['intern'], keyword_min_total: 1000, facet_values: ['Seasonal'] }, ctx);
  assert.deepEqual(ctx.calls.slice(1).map(filterOf), [F_SEASONAL]);
  assert.equal(jobs.keywordSearch.mode, 'facet');
  assert.deepEqual(jobs.keywordSearch.facet, { name: 'categories', values: ['Seasonal'] });
  assert.equal(jobs.length, 2);
});

test('time type / job family / job family group / tags count as preferred facets', () => {
  for (const label of ['Time Type', 'Job Family', 'Job Family Group', 'Tags']) {
    const g = facetFilters({
      organizationsFacet: [{ Id: 7, Name: 'Intern', TotalCount: 1 }],
      flexFieldsFacet: [{ Name: 'AttributeChar6', Label: label, values: [{ Id: 'Intern', Name: 'Intern', TotalCount: 20 }] }],
    });
    assert.equal(chooseFacet(g).name, `flex:AttributeChar6 (${label})`, label);
  }
});

test('health probe (ctx.maxPages) bounds the whole-board walk when keywords are absent', async () => {
  for (const keywords of [undefined, [], false]) {
    const ctx = makeCtx({ '': 450 });
    ctx.maxPages = 1;
    const jobs = await oc.fetch({ name: 'Acme', careers_url: CAREERS, keywords }, ctx);
    assert.deepEqual(ctx.calls.map(offsetOf), [0]);
    assert.equal(jobs.length, 200);
    assert.equal(jobs.keywordSearch, undefined);
  }
});
