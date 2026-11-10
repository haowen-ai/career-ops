// tests/providers/successfactors-keywords.test.mjs — keyword search for big
// SuccessFactors boards (2026-11-09): entry.keywords runs the crawl once per
// term through the site's own search (q= on /tile-search-results/, keywords on
// the CSB jobs API); entry.keyword_min_total keeps small boards on the full fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { ROOT } from '../helpers.mjs';

const mod = await import(pathToFileURL(join(ROOT, 'providers/successfactors.mjs')).href);
const sf = mod.default;
const { parseRmkTotal, normalizeKeywords, termConfig, resolveConfig } = mod;

const tile = (id, title) =>
  `<li class="job-tile job-id-${id}" data-url="/job/City-${title.replace(/\W+/g, '-')}/${id}/"><a class="jobTitle-link" href="#">${title}</a></li>`;
const searchPage = (total) =>
  `<html><span class="paginationLabel" aria-label="Results 1 – 25">Results <b>1 – 25</b> of <b>${total}</b></span></html>`;

/**
 * In-memory RMK tenant. `board` = ids of the unfiltered board; `byTerm` maps a
 * q= term to the ids it matches. Page size 25. Records every request URL.
 */
function rmkSite({ board = [], byTerm = {}, total = null, pageSize = 25, facets = null, byFacet = {} }) {
  const calls = [];
  const ctx = {
    sleep: async () => {},
    fetchText: async (url) => {
      calls.push(url);
      const u = new URL(url);
      if (u.pathname === '/search/') {
        const page = total === null ? '<html>no label</html>' : searchPage(total);
        if (!facets) return page;
        const fields = Object.keys(facets);
        return page + fields.map((f) => `<label id="optionsFacetsDD_${f}_label" class="optionsFacet"> Label ${f} </label><select name="optionsFacetsDD_${f}"><option value="">All</option></select>`).join('')
          + `<script>j2w.search.options = { isOpen: false, facets: ${JSON.stringify(fields)}, showPicklistAllLocales : false };</script>`;
      }
      const fk = [...u.searchParams.keys()].find((k) => k.startsWith('optionsFacetsDD_'));
      if (fk) {
        const ids = byFacet[`${fk.slice('optionsFacetsDD_'.length)}=${u.searchParams.get(fk)}`] || [];
        const start = Number(u.searchParams.get('startrow') || 0);
        return ids.slice(start, start + pageSize).map((id) => tile(id, `Role ${id}`)).join('');
      }
      const q = u.searchParams.get('q');
      const ids = q === null ? board : byTerm[q] || [];
      const start = Number(u.searchParams.get('startrow') || 0);
      return ids.slice(start, start + pageSize).map((id) => tile(id, `Role ${id}`)).join('');
    },
    fetchJson: async (url, opts) => {
      calls.push(url);
      if (facets && new URL(url).pathname === '/services/jobs/options/facetValues/') {
        const body = JSON.parse(opts.body);
        const map = {};
        for (const f of body.facetquery.fields) map[f] = facets[f].map((name) => ({ translated: '', name, count: (byFacet[`${f}=${name}`] || [1]).length }));
        return { facets: { map } };
      }
      throw new Error('CSB must not run on an RMK tenant');
    },
  };
  return { ctx, calls };
}

const tileCalls = (calls) => calls.filter((u) => new URL(u).pathname === '/tile-search-results/');
const qOf = (u) => new URL(u).searchParams.get('q');

test('helpers: total parsing, keyword normalisation, per-term config', () => {
  assert.equal(parseRmkTotal(searchPage(173)), 173);
  assert.equal(parseRmkTotal(searchPage('1,242')), 1242);
  assert.equal(parseRmkTotal('<html>There are currently no open positions</html>'), null);
  assert.deepEqual(normalizeKeywords(['intern', ' intern ', '', 3, 'co-op']), ['intern', 'co-op']);
  assert.deepEqual(normalizeKeywords(false), []);
  assert.deepEqual(normalizeKeywords(undefined), []);
  const cfg = resolveConfig({ name: 'SAP', careers_url: 'https://careers.sap.com/search/?q=old&locationsearch=United+States' });
  const t = termConfig(cfg, 'summer analyst');
  assert.equal(new URLSearchParams(t.searchQuery).get('q'), '"summer analyst"', 'multi-word term is a quoted phrase');
  assert.equal(new URLSearchParams(termConfig(cfg, 'co-op').searchQuery).get('q'), 'co-op');
  assert.equal(new URLSearchParams(termConfig(cfg, '"early career"').searchQuery).get('q'), '"early career"');
  assert.equal(new URLSearchParams(t.searchQuery).get('locationsearch'), 'United States');
  assert.equal(t.keywords, 'summer analyst');
});

test('keywords absent / empty / false → full fetch exactly as today', async () => {
  for (const keywords of [undefined, [], false]) {
    const { ctx, calls } = rmkSite({ board: [1, 2, 3], byTerm: { intern: [1] }, total: 3 });
    const entry = { name: 'Small', careers_url: 'https://jobs.small.example', keyword_min_total: 1 };
    if (keywords !== undefined) entry.keywords = keywords;
    const jobs = await sf.fetch(entry, ctx);
    assert.equal(jobs.length, 3);
    assert.equal(jobs.keywordSearch, undefined);
    assert.deepEqual(calls, ['https://jobs.small.example/tile-search-results/?startrow=0', 'https://jobs.small.example/tile-search-results/?startrow=3']);
    assert.deepEqual(Object.keys(jobs[0]).sort(), ['company', 'location', 'title', 'url']);
  }
});

test('total ≤ keyword_min_total → full fetch, no keyword requests', async () => {
  const { ctx, calls } = rmkSite({ board: [1, 2, 3], byTerm: { intern: [1] }, total: 3 });
  const jobs = await sf.fetch({ name: 'Small', careers_url: 'https://jobs.small.example', keywords: ['intern', 'co-op'], keyword_min_total: 500 }, ctx);
  assert.equal(jobs.length, 3);
  assert.equal(jobs.keywordSearch, undefined);
  assert.equal(calls[0], 'https://jobs.small.example/search/?startrow=0');
  assert.ok(tileCalls(calls).every((u) => qOf(u) === null), 'no q= request on a small board');
});

test('total > keyword_min_total → one query per term, merged in term/page order, deduped, marked', async () => {
  const internIds = Array.from({ length: 30 }, (_, i) => 100 + i); // two pages
  const { ctx, calls } = rmkSite({
    board: Array.from({ length: 2000 }, (_, i) => i),
    byTerm: { intern: internIds, 'co-op': [7, 100, 101], student: [] },
    total: 2000,
  });
  const jobs = await sf.fetch({ name: 'Big', careers_url: 'https://jobs.big.example', keywords: ['intern', 'co-op', 'student'], keyword_min_total: 500 }, ctx);
  assert.deepEqual(jobs.map((j) => j.title), [...internIds.map((id) => `Role ${id}`), 'Role 7']);
  assert.deepEqual(jobs.keywordSearch, { mode: 'keywords', terms: 3, boardTotal: 2000, perTerm: { intern: 30, 'co-op': 3, student: 0 } });
  assert.equal(jobs.truncated, undefined);
  const qs = tileCalls(calls).map(qOf);
  assert.ok(!qs.includes(null), 'never pages the unfiltered board');
  assert.deepEqual([...new Set(qs)], ['intern', 'co-op', 'student']);
  assert.deepEqual(Object.keys(jobs[0]).sort(), ['company', 'location', 'title', 'url']);
});

test('a term that hits max_jobs marks the array truncated', async () => {
  const { ctx } = rmkSite({ board: [], byTerm: { intern: Array.from({ length: 60 }, (_, i) => i), 'co-op': [1000] }, total: 5000 });
  const jobs = await sf.fetch({ name: 'Big', careers_url: 'https://jobs.big.example', keywords: ['intern', 'co-op'], keyword_min_total: 500, max_jobs: 50 }, ctx);
  assert.equal(jobs.truncated, true);
  assert.equal(jobs.keywordSearch.perTerm.intern, 50);
  assert.equal(jobs.length, 51);
});

test('unknown total (no count on the page, or no keyword_min_total) → keyword search', async () => {
  const site1 = rmkSite({ board: [1, 2, 3], byTerm: { intern: [2] }, total: null });
  const a = await sf.fetch({ name: 'X', careers_url: 'https://jobs.x.example', keywords: ['intern'], keyword_min_total: 500 }, site1.ctx);
  assert.deepEqual(a.map((j) => j.title), ['Role 2']);
  assert.deepEqual(a.keywordSearch, { mode: 'keywords', terms: 1, boardTotal: null, perTerm: { intern: 1 } });

  const site2 = rmkSite({ board: [1, 2, 3], byTerm: { intern: [2] }, total: 3 });
  const b = await sf.fetch({ name: 'X', careers_url: 'https://jobs.x.example', keywords: ['intern'], facet: false }, site2.ctx);
  assert.deepEqual(b.map((j) => j.title), ['Role 2']);
  assert.equal(b.keywordSearch.boardTotal, null);
  assert.ok(!site2.calls.some((u) => new URL(u).pathname === '/search/'), 'no search-page request without keyword_min_total when facet: false');
});

test('every term empty on a real RMK board → [] (no full-board fallback)', async () => {
  const { ctx, calls } = rmkSite({ board: [1, 2], byTerm: {}, total: 9000 });
  const jobs = await sf.fetch({ name: 'X', careers_url: 'https://jobs.x.example', keywords: ['intern', 'co-op'], keyword_min_total: 500 }, ctx);
  assert.equal(jobs.length, 0);
  assert.deepEqual(jobs.keywordSearch.perTerm, { intern: 0, 'co-op': 0 });
  assert.equal(tileCalls(calls).filter((u) => qOf(u) === null).length, 1, 'one unfiltered probe page only');
});

test('CSB tenant (empty tile shell) → keywords go into the jobs-API body per term', async () => {
  const bodies = [];
  const byTerm = { intern: ['a', 'b'], 'co-op': ['b', 'c'] };
  const ctx = {
    sleep: async () => {},
    fetchText: async () => '<!DOCTYPE html><a href="/search/?locale=en_US">EN</a>',
    fetchJson: async (url, opts) => {
      const body = JSON.parse(opts.body);
      bodies.push(body);
      const ids = byTerm[body.keywords] || [];
      return { totalJobs: ids.length, jobSearchResult: ids.map((id) => ({ response: { id, unifiedStandardTitle: `Job ${id}`, urlTitle: `Job-${id}` } })) };
    },
  };
  for (const sfVariant of [undefined, 'csb']) {
    bodies.length = 0;
    const entry = { name: 'C', careers_url: 'https://careers.c.example', keywords: ['intern', 'co-op'], keyword_min_total: 500 };
    if (sfVariant) entry.sfVariant = sfVariant;
    const jobs = await sf.fetch(entry, ctx);
    assert.deepEqual(jobs.map((j) => j.title), ['Job a', 'Job b', 'Job c']);
    assert.deepEqual(jobs.keywordSearch, { mode: 'keywords', terms: 2, boardTotal: null, perTerm: { intern: 2, 'co-op': 2 } });
    assert.deepEqual(bodies.map((b) => b.keywords), ['intern', 'co-op']);
  }
});

const facetSite = () => rmkSite({
  board: Array.from({ length: 2000 }, (_, i) => i),
  byTerm: { intern: [5] },
  total: 2000,
  facets: { customfield1: ['Finance', 'International Sales', 'Retail'], customfield2: ['Regular', 'Intern/Trainee', 'Working Students'] },
  byFacet: { 'customfield2=Intern/Trainee': Array.from({ length: 30 }, (_, i) => 500 + i), 'customfield2=Working Students': [529, 600] },
});

test('student facet on the site → facet views read, no keyword requests', async () => {
  const { ctx, calls } = facetSite();
  const jobs = await sf.fetch({ name: 'Big', careers_url: 'https://jobs.big.example', keywords: ['intern', 'co-op'], keyword_min_total: 500 }, ctx);
  assert.equal(jobs.length, 31);
  assert.equal(jobs[0].title, 'Role 500');
  assert.equal(jobs.at(-1).title, 'Role 600');
  assert.deepEqual(jobs.keywordSearch, {
    mode: 'facet',
    facet: { name: 'customfield2', label: 'Label customfield2', values: ['Intern/Trainee', 'Working Students'] },
    terms: 2, boardTotal: 2000, perTerm: { 'Intern/Trainee': 30, 'Working Students': 2 },
  });
  assert.ok(tileCalls(calls).every((u) => qOf(u) === null), 'no q= request');
  assert.ok(tileCalls(calls).every((u) => [...new URL(u).searchParams.keys()].some((k) => k === 'optionsFacetsDD_customfield2')));
  assert.equal(calls.filter((u) => u.endsWith('/services/jobs/options/facetValues/')).length, 1);
});

test('no matching facet value ("International" is not intern) → keyword search', async () => {
  const { ctx, calls } = rmkSite({
    board: [1, 2, 3], byTerm: { intern: [2] }, total: 2000,
    facets: { customfield1: ['International Sales', 'Internal Audit', 'Retail'] },
  });
  const jobs = await sf.fetch({ name: 'X', careers_url: 'https://jobs.x.example', keywords: ['intern'], keyword_min_total: 500 }, ctx);
  assert.equal(jobs.keywordSearch.mode, 'keywords');
  assert.equal(jobs.keywordSearch.facet, undefined);
  assert.deepEqual(jobs.map((j) => j.title), ['Role 2']);
  assert.ok(calls.some((u) => u.endsWith('/services/jobs/options/facetValues/')));
});

test('matching facet whose views are empty → keyword search', async () => {
  const { ctx } = rmkSite({ board: [1], byTerm: { intern: [1] }, total: 2000, facets: { customfield2: ['Interns'] }, byFacet: { 'customfield2=Interns': [] } });
  const jobs = await sf.fetch({ name: 'X', careers_url: 'https://jobs.x.example', keywords: ['intern'], keyword_min_total: 500 }, ctx);
  assert.equal(jobs.keywordSearch.mode, 'keywords');
  assert.equal(jobs.length, 1);
});

test('entry.facet: false → no facet discovery, keyword search', async () => {
  const { ctx, calls } = facetSite();
  const jobs = await sf.fetch({ name: 'Big', careers_url: 'https://jobs.big.example', keywords: ['intern'], keyword_min_total: 500, facet: false }, ctx);
  assert.equal(jobs.keywordSearch.mode, 'keywords');
  assert.deepEqual(jobs.map((j) => j.title), ['Role 5']);
  assert.ok(!calls.some((u) => u.includes('facetValues')));
});

test('facet helpers: field list from the page script, label, student value pick', () => {
  const html = `<label id="optionsFacetsDD_customfield1_label" class="optionsFacet"> Experience Level </label><script>j2w.search.options = { isOpen: false, facets: ["country","customfield1"], showPicklistAllLocales : false };</script>`;
  const fields = mod.extractFacetFields(html);
  assert.deepEqual(fields, [{ field: 'country', label: '' }, { field: 'customfield1', label: 'Experience Level' }]);
  const pick = mod.pickStudentFacet({ facets: { map: { country: [{ name: 'US', count: 5 }], customfield1: [{ name: 'Interns', count: 11 }, { name: 'Professional', count: 248 }] } } }, fields);
  assert.deepEqual(pick, { name: 'customfield1', label: 'Experience Level', values: ['Interns'] });
  assert.equal(mod.pickStudentFacet({ facets: { map: { customfield1: [{ name: 'International', count: 3 }] } } }, fields), null);
});

test('widened matcher: contract / master values selected with intern, all values of the chosen field merged', () => {
  const fields = [{ field: 'customfield2', label: 'Employee Class' }, { field: 'customfield1', label: 'Job Family' }];
  const json = { facets: { map: {
    customfield2: [{ name: 'Contract', count: 2 }, { name: 'Intern/Trainee', count: 19 }, { name: 'Regular', count: 732 }, { name: "Master's Program", count: 3 }],
    customfield1: [{ name: 'International Sales', count: 9 }, { name: 'Internal Audit', count: 4 }, { name: 'Retail', count: 1090 }],
  } } };
  assert.deepEqual(mod.pickStudentFacet(json, fields), { name: 'customfield2', label: 'Employee Class', values: ['Contract', 'Intern/Trainee', "Master's Program"] });
  // The free-text title field (one value per posting title) is never the student facet.
  const withTitle = { facets: { map: { ...json.facets.map, title: Array.from({ length: 40 }, (_, i) => ({ name: `Intern ${i}`, count: 1 })) } } };
  assert.equal(mod.pickStudentFacet(withTitle, [...fields, { field: 'title', label: 'Title' }]).name, 'customfield2');
});

test('every matching value of the facet is fetched and merged', async () => {
  const { ctx, calls } = rmkSite({
    board: [], total: 2000,
    facets: { customfield2: ['Contract', 'Intern/Trainee', 'Regular'] },
    byFacet: { 'customfield2=Contract': [1, 2], 'customfield2=Intern/Trainee': [2, 3, 4] },
  });
  const jobs = await sf.fetch({ name: 'Big', careers_url: 'https://jobs.big.example', keywords: ['intern'], keyword_min_total: 500 }, ctx);
  assert.equal(jobs.keywordSearch.mode, 'facet');
  assert.deepEqual(jobs.keywordSearch.facet.values, ['Contract', 'Intern/Trainee']);
  assert.deepEqual(jobs.map((j) => j.title), ['Role 1', 'Role 2', 'Role 3', 'Role 4']);
  assert.deepEqual(jobs.keywordSearch.perTerm, { Contract: 2, 'Intern/Trainee': 3 });
  assert.ok(!tileCalls(calls).some((u) => new URL(u).searchParams.get('optionsFacetsDD_customfield2') === 'Regular'));
});

test('review fix: a customfield labelled "Location" is never the student facet; worker-type labels win', () => {
  const fields = [{ field: 'customfield1', label: 'Location' }, { field: 'customfield2', label: 'Experience Level' }, { field: 'customfield3', label: 'Department' }];
  const json = { facets: { map: {
    customfield1: [{ name: 'University Park', count: 100 }],
    customfield2: [{ name: 'Intern', count: 10 }],
    customfield3: [{ name: 'Campus Recruiting', count: 50 }],
  } } };
  assert.deepEqual(mod.pickStudentFacet(json, fields), { name: 'customfield2', label: 'Experience Level', values: ['Intern'] });
  assert.equal(mod.pickStudentFacet(json, [{ field: 'customfield1', label: 'Job Title' }]), null);
});

test('review item 1: keywords absent keeps the pre-existing careers_url filter behaviour (no keyword/facet requests added)', async () => {
  const calls = [];
  const jobs = await sf.fetch({ name: 'SAP', careers_url: 'https://careers.sap.com/search/?q=intern' }, {
    sleep: async () => {},
    fetchText: async (url) => { calls.push(url); return calls.length === 1 ? tile(1, 'Intern A') : ''; },
    fetchJson: async () => { throw new Error('no facet/CSB call expected'); },
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs.keywordSearch, undefined);
  assert.deepEqual(calls, ['https://careers.sap.com/tile-search-results/?q=intern&startrow=0', 'https://careers.sap.com/tile-search-results/?q=intern&startrow=1']);
});

test('facet_values is a word list: whole words, case-insensitive, plural / \'s; non-strings ignored; empty → default words', async () => {
  const m = mod.facetValueMatcher;
  const d = m(undefined);
  for (const v of ['Intern/Trainee', 'Interns', "Master's Program", 'Working Students', 'Early Career', 'Co-Op', 'Contract', 'Graduate Scheme']) assert.ok(d.test(v), `default matches ${v}`);
  for (const v of ['Internal Audit', 'International', 'Mastering Retail', 'Contractor', 'Studentship']) assert.equal(d.test(v), false, `default rejects ${v}`);
  assert.equal(m([]).source, d.source);
  assert.equal(m([3, null, '  ']).source, d.source, 'non-strings and blanks ignored → default');
  const custom = m(['Praktikum', 'Werkstudent', 3, 'co-op']);
  assert.ok(custom.test('Werkstudenten') === false && custom.test('Werkstudent') && custom.test('PRAKTIKUM (m/w/d)') && custom.test('Co-Op'));
  assert.equal(custom.test('Intern'), false, 'configured list replaces the default');
  assert.equal(m(['a.b']).test('aXb'), false, 'words are escaped, not regexes');

  const { ctx, calls } = rmkSite({
    board: [], total: 2000,
    facets: { customfield2: ['Contract', 'Intern/Trainee', 'Regular'] },
    byFacet: { 'customfield2=Contract': [1, 2], 'customfield2=Intern/Trainee': [2, 3, 4] },
  });
  const jobs = await sf.fetch({ name: 'Big', careers_url: 'https://jobs.big.example', keywords: ['intern'], keyword_min_total: 500, facet_values: ['INTERN'] }, ctx);
  assert.deepEqual(jobs.keywordSearch.facet.values, ['Intern/Trainee']);
  assert.deepEqual(jobs.map((j) => j.title), ['Role 2', 'Role 3', 'Role 4']);
  assert.ok(!tileCalls(calls).some((u) => new URL(u).searchParams.get('optionsFacetsDD_customfield2') === 'Contract'));
});

test('internal/international are excluded under any word list; values are capped at 200 chars', () => {
  const fields = [{ field: 'customfield1', label: 'Experience Level' }];
  const json = { facets: { map: { customfield1: [{ name: 'International', count: 5 }, { name: 'Internal Audit', count: 4 }, { name: 'Internship', count: 3 }, { name: 'Intern - International Program', count: 1 }] } } };
  assert.deepEqual(mod.pickStudentFacet(json, fields).values, ['Internship', 'Intern - International Program']);
  assert.deepEqual(mod.pickStudentFacet(json, fields, mod.facetValueMatcher(['intern', 'internship', 'audit'])).values, ['Internal Audit', 'Internship', 'Intern - International Program'], 'a configured word may match the rest of the value');
  assert.equal(mod.pickStudentFacet({ facets: { map: { customfield1: [{ name: 'Internal', count: 4 }, { name: 'International Sales', count: 2 }] } } }, fields, mod.facetValueMatcher(['international', 'internal'])), null, 'the excluded words never match, even when configured');
  const long = { facets: { map: { customfield1: [{ name: 'a'.repeat(5000) + ' intern', count: 1 }, { name: 'Interns', count: 2 }] } } };
  assert.deepEqual(mod.pickStudentFacet(long, fields).values, ['Interns']);
});

test('final review: plural place labels ("Locations"), >200-value facets excluded; fewest matching jobs wins; no cross-facet merge', async () => {
  const fields = [{ field: 'customfield1', label: 'Locations' }, { field: 'customfield2', label: 'Experience Level' }, { field: 'customfield3', label: 'Job Type' }, { field: 'customfield4', label: 'Programs' }];
  const json = { facets: { map: {
    customfield1: [{ name: 'University Park', count: 100 }],
    customfield2: [{ name: 'Interns', count: 30 }, { name: 'Professional', count: 500 }],
    customfield3: [{ name: 'Internship', count: 12 }, { name: 'Contract', count: 3 }],
    customfield4: Array.from({ length: 201 }, (_, i) => ({ name: `Student program ${i}`, count: 1 })),
  } } };
  assert.deepEqual(mod.pickStudentFacet(json, fields), { name: 'customfield3', label: 'Job Type', values: ['Internship', 'Contract'] });

  // End to end: the "Locations" facet must not be read; the real student facet is.
  const { ctx, calls } = rmkSite({
    board: [], byTerm: { intern: [9] }, total: 2000,
    facets: { customfield1: ['University Park'], customfield2: ['Interns'] },
    byFacet: { 'customfield1=University Park': [70, 71], 'customfield2=Interns': [1, 2] },
  });
  // rmkSite labels every field "Label <field>"; relabel customfield1 as "Locations".
  const realFetchText = ctx.fetchText;
  ctx.fetchText = async (url) => (await realFetchText(url)).replace('Label customfield1', 'Locations');
  const jobs = await sf.fetch({ name: 'Big', careers_url: 'https://jobs.big.example', keywords: ['intern'], keyword_min_total: 500 }, ctx);
  assert.equal(jobs.keywordSearch.facet.name, 'customfield2');
  assert.deepEqual(jobs.map((j) => j.title), ['Role 1', 'Role 2']);
  assert.ok(!tileCalls(calls).some((u) => new URL(u).searchParams.has('optionsFacetsDD_customfield1')));
});

test('probe (ctx.maxPages) ignores keywords and facets: unfiltered pages up to maxPages, no marker', async () => {
  const site = facetSite();
  site.ctx.maxPages = 1;
  const jobs = await sf.fetch({ name: 'Big', careers_url: 'https://jobs.big.example', keywords: ['intern'], keyword_min_total: 500, facet: false }, site.ctx);
  assert.equal(jobs.length, 25);
  assert.equal(jobs.keywordSearch, undefined);
  assert.deepEqual(site.calls, ['https://jobs.big.example/tile-search-results/?startrow=0']);
  const site2 = facetSite();
  site2.ctx.maxPages = 1;
  await sf.fetch({ name: 'Big', careers_url: 'https://jobs.big.example', keywords: ['intern'], keyword_min_total: 500 }, site2.ctx);
  assert.deepEqual(site2.calls, ['https://jobs.big.example/tile-search-results/?startrow=0'], 'no search page / facetValues on a probe');
});

test('"Job Family" / "Job Family Group" labels count as preferred facets', () => {
  for (const label of ['Job Family', 'Job Family Group']) {
    const fields = [{ field: 'customfield1', label: 'Department' }, { field: 'customfield2', label }];
    const json = { facets: { map: { customfield1: [{ name: 'Campus Recruiting', count: 2 }], customfield2: [{ name: 'Students & Graduates', count: 40 }] } } };
    assert.equal(mod.pickStudentFacet(json, fields).name, 'customfield2', label);
  }
});
