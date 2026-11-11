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
  assert.equal(t.keywords, '"summer analyst"', 'CSB keywords get the same quoted phrase (Aramark 11/11)');
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

// ── 2026-11-11 scan-coverage fixes (Aramark, Under Armour, Compass, Edison) ──

test('tile-layout count: jobRecordsFound in the page script is the board total', async () => {
  const page = '<script>j2w.SearchResults.init({ apiEndpoint: "tile-search-results", jobRecordsPerPage: parseInt("10"), jobRecordsFound: parseInt("217") });</script>';
  assert.equal(parseRmkTotal(page), 217);
  // A small board stated this way now stays on the full fetch (Edison: 217 ≤ 400).
  const calls = [];
  const ctx = {
    fetchText: async (url) => {
      calls.push(url);
      const u = new URL(url);
      if (u.pathname === '/search/') return page.replace('217', '3');
      if (u.searchParams.get('q') !== null) throw new Error('no keyword query on a small board');
      const start = Number(u.searchParams.get('startrow'));
      return [1, 2, 3].slice(start, start + 10).map((id) => tile(id, `Role ${id}`)).join('');
    },
    fetchJson: async () => { throw new Error('RMK only'); },
  };
  const jobs = await sf.fetch({ name: 'E', careers_url: 'https://apply.e.example', keywords: ['intern'], keyword_min_total: 400 }, ctx);
  assert.equal(jobs.length, 3);
  assert.equal(jobs.keywordSearch, undefined);
});

/**
 * In-memory CSB tenant (empty tile shell). `byKeywords` maps the exact body
 * keywords to ids; `facetPage` adds the facetFields script; `facetJobs` maps
 * "<locale>|<field>=<value>" to ids (counts and filtered crawls come from it).
 */
function csbSite({ locales = ['en_US'], byKeywords = {}, facetPage = false, facetJobs = {}, totals = {} }) {
  const bodies = [];
  const links = locales.map((l) => `<a href="/search/?q=&amp;locale=${l}">${l}</a>`).join('');
  const script = facetPage
    ? '<script>var facetFields = []; facetFields.push( { fieldId:"department", label:"Career Area" }) facetFields.push( { fieldId:"jobLocationCity", label:"City" }) resultStyles.searchFacet.facetFields = facetFields; var jobResultsCardFields = []; jobResultsCardFields.push( { fieldId: "brand", label: "Brand", showLabel: true });</script>'
    : '';
  const ctx = {
    fetchText: async (url) => (new URL(url).pathname.startsWith('/tile-search-results/') ? '<!DOCTYPE html>' : `<html>${links}${script}</html>`),
    fetchJson: async (url, opts) => {
      const body = JSON.parse(opts.body);
      bodies.push(body);
      if (body.facetingOnly) {
        const values = {};
        for (const [k, ids] of Object.entries(facetJobs)) {
          const [loc, fv] = k.split('|');
          if (loc !== body.locale) continue;
          const [field, value] = fv.split('=');
          (values[field] ??= []).push({ name: value, count: ids.length });
        }
        return { totalJobs: totals[body.locale] ?? 0, facetFields: body.facetFields.map((name) => ({ name, values: values[name] || [{ name: 'Food Service', count: 99 }] })), jobSearchResult: [] };
      }
      let ids;
      if (body.facetFilters) {
        ids = [];
        for (const [field, vals] of Object.entries(body.facetFilters)) for (const v of vals) ids.push(...(facetJobs[`${body.locale}|${field}=${v}`] || []));
      } else ids = byKeywords[body.keywords] || [];
      const page = ids.slice(body.pageNumber * 10, body.pageNumber * 10 + 10);
      return { totalJobs: ids.length, jobSearchResult: page.map((id) => ({ response: { id, unifiedStandardTitle: `Job ${id}`, urlTitle: `Job-${id}` } })) };
    },
  };
  return { ctx, bodies };
}

test('Aramark: a multi-word term goes to the CSB API as a quoted phrase, so it no longer hits max_jobs', async () => {
  const everything = Array.from({ length: 60 }, (_, i) => `w${i}`);
  const { ctx, bodies } = csbSite({ byKeywords: { 'early career': everything, '"early career"': ['e1', 'e2'], intern: ['i1', 'e1'] } });
  const jobs = await sf.fetch({ name: 'Aramark', careers_url: 'https://aramark.example', keywords: ['intern', 'early career'], keyword_min_total: 400, max_jobs: 50 }, ctx);
  assert.deepEqual(bodies.filter((b) => !b.facetingOnly).map((b) => b.keywords), ['intern', '"early career"']);
  assert.deepEqual(jobs.map((j) => j.title), ['Job i1', 'Job e1', 'Job e2']);
  assert.equal(jobs.truncated, undefined);
  assert.deepEqual(jobs.keywordSearch.perTerm, { intern: 2, 'early career': 2 });
});

test('CSB student facet: values read with facetingOnly per locale, only locales with hits crawled, facetFilters in the body', async () => {
  const early = Array.from({ length: 12 }, (_, i) => `ec${i}`);
  const { ctx, bodies } = csbSite({
    locales: ['en_US', 'de_DE', 'fr_CA'],
    facetPage: true,
    totals: { en_US: 6897, de_DE: 224, fr_CA: 70 },
    facetJobs: { 'en_US|department=Early Careers': early, 'en_US|department=Food Service': ['f1', 'f2', 'f3'], 'de_DE|department=Food Service': ['f9'] },
    byKeywords: { intern: ['x'] },
  });
  const jobs = await sf.fetch({ name: 'Aramark', careers_url: 'https://aramark.example', keywords: ['intern', 'student'], keyword_min_total: 400 }, ctx);
  assert.equal(jobs.length, 12);
  assert.equal(jobs[0].url, 'https://aramark.example/job/Job-ec0/ec0-en_US');
  assert.deepEqual(jobs.keywordSearch, {
    mode: 'facet',
    facet: { name: 'department', label: 'Career Area', values: ['Early Careers'] },
    terms: 2,
    boardTotal: 6897 + 224 + 70,
    perTerm: { 'Early Careers': 12 },
  });
  const faceting = bodies.filter((b) => b.facetingOnly);
  assert.deepEqual(faceting.map((b) => b.locale), ['de_DE', 'en_US', 'fr_CA'], 'one faceting request per page locale');
  assert.deepEqual(faceting[0].facetFields, ['department', 'jobLocationCity'], 'fields from the facetFields script, not the result-card fields');
  const crawl = bodies.filter((b) => !b.facetingOnly);
  assert.ok(crawl.every((b) => b.locale === 'en_US' && b.keywords === '' && JSON.stringify(b.facetFilters) === '{"department":["Early Careers"]}'));
  assert.deepEqual(crawl.map((b) => b.pageNumber), [0, 1]);
});

test('CSB: no student facet value, or facet: false → keyword search (no facetFilters)', async () => {
  const opts = { facetPage: true, facetJobs: { 'en_US|department=Food Service': ['f1'] }, byKeywords: { intern: ['i1'] } };
  const a = csbSite(opts);
  const jobs = await sf.fetch({ name: 'C', careers_url: 'https://c.example', keywords: ['intern'], keyword_min_total: 400 }, a.ctx);
  assert.equal(jobs.keywordSearch.mode, 'keywords');
  assert.deepEqual(jobs.map((j) => j.title), ['Job i1']);
  const b = csbSite({ ...opts, facetJobs: { 'en_US|department=Early Careers': ['e1'] } });
  const off = await sf.fetch({ name: 'C', careers_url: 'https://c.example', keywords: ['intern'], keyword_min_total: 400, facet: false }, b.ctx);
  assert.equal(off.keywordSearch.mode, 'keywords');
  assert.ok(b.bodies.every((x) => !x.facetingOnly && !x.facetFilters));
});

/** Under Armour-like tile tenant with a category page; past the end it serves a fixed unrelated block. */
function categorySite({ catIds, boardCount = 724, statedCount = catIds.length }) {
  const calls = [];
  const junk = [9001, 9002, 9003, 9004, 9005];
  const ctx = {
    fetchText: async (url) => {
      calls.push(url);
      const u = new URL(url);
      if (u.pathname === '/search/') return `<script>j2w.SearchResults.init({ jobRecordsPerPage: parseInt("10"), jobRecordsFound: parseInt("${boardCount}") });</script>`;
      if (u.pathname === '/go/Internships/9635400/') return `<script>j2w.SearchResults.init({ apiEndpoint: "tile-search-results/category/9635400", jobRecordsPerPage: parseInt("10"), jobRecordsFound: parseInt("${statedCount}") });</script>`;
      if (u.pathname === '/tile-search-results/category/9635400/') {
        const start = Number(u.searchParams.get('startrow'));
        const page = catIds.slice(start, start + 10);
        return (page.length ? page : junk).map((id) => tile(id, `Role ${id}`)).join('');
      }
      throw new Error(`unexpected request ${url}`);
    },
    fetchJson: async () => { throw new Error('no CSB on a category page'); },
  };
  return { ctx, calls };
}

test('category careers_url (/go/<Name>/<id>/): resolved to the category tile endpoint', () => {
  const cfg = resolveConfig({ name: 'UA', careers_url: 'https://careers.underarmour.com/go/Internships/9635400/' });
  assert.equal(cfg.tileApi, 'https://careers.underarmour.com/tile-search-results/category/9635400/');
  assert.equal(cfg.searchPage, 'https://careers.underarmour.com/search/');
  assert.deepEqual(cfg.category, { id: '9635400', name: 'Internships', page: 'https://careers.underarmour.com/go/Internships/9635400/' });
  const brand = resolveConfig({ name: 'B', careers_url: 'https://careers.x.example/Brand/go/Early-Careers/42/' });
  assert.equal(brand.tileApi, 'https://careers.x.example/Brand/tile-search-results/category/42/');
  assert.equal(brand.category.name, 'Early Careers');
  assert.equal(resolveConfig({ name: 'Z', careers_url: 'https://jobs.zf.com' }).category, null);
});

test('Under Armour: category page in keyword mode → read as the site filter, stops at its stated count, no keyword queries', async () => {
  const catIds = Array.from({ length: 21 }, (_, i) => 100 + i);
  const { ctx, calls } = categorySite({ catIds });
  const jobs = await sf.fetch({ name: 'UA', careers_url: 'https://careers.underarmour.com/go/Internships/9635400/', keywords: ['intern', 'co-op'], keyword_min_total: 400 }, ctx);
  assert.deepEqual(jobs.map((j) => j.title), catIds.map((id) => `Role ${id}`), 'the past-the-end block (9001…) is not read');
  assert.equal(jobs.truncated, undefined);
  assert.deepEqual(jobs.keywordSearch, {
    mode: 'facet',
    facet: { name: 'category', label: 'Category', values: ['Internships'] },
    terms: 2,
    boardTotal: 724,
    perTerm: { Internships: 21 },
  });
  assert.ok(!calls.some((u) => new URL(u).searchParams.has('q')));
});

test('category page without keywords (scan.mjs) → category endpoint, stated count, no CSB fallback even when empty', async () => {
  const site = categorySite({ catIds: [1, 2, 3] });
  const jobs = await sf.fetch({ name: 'UA', careers_url: 'https://careers.underarmour.com/go/Internships/9635400/' }, site.ctx);
  assert.deepEqual(jobs.map((j) => j.title), ['Role 1', 'Role 2', 'Role 3']);
  assert.equal(jobs.keywordSearch, undefined);
  const empty = categorySite({ catIds: [], statedCount: 0 });
  // stated count 0: no tile request at all (the endpoint would serve the filler block), no CSB request
  const none = await sf.fetch({ name: 'UA', careers_url: 'https://careers.underarmour.com/go/Internships/9635400/' }, empty.ctx);
  assert.equal(none.length, 0);
  assert.deepEqual(empty.calls, ['https://careers.underarmour.com/go/Internships/9635400/']);
  // a filler tile on the last real page is trimmed to the stated count
  const short = categorySite({ catIds: [1, 2, 3], statedCount: 2 });
  assert.deepEqual((await sf.fetch({ name: 'UA', careers_url: 'https://careers.underarmour.com/go/Internships/9635400/' }, short.ctx)).map((j) => j.title), ['Role 1', 'Role 2']);
});
