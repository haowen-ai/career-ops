// tests/providers/smartrecruiters-keywords.test.mjs — keyword search on big
// SmartRecruiters boards (entry.keywords / entry.keyword_min_total).
// No network — ctx.fetchJson is stubbed.
//
// Run:  node --test tests/providers/smartrecruiters-keywords.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/smartrecruiters.mjs')).href);
const sr = mod.default;
const { formatSearchTerm, parseKeywordConfig, facetUsable, parseFacetValues, selectFacetValues, facetValueMatcher } = mod;

const BASE = { name: 'BigCo', careers_url: 'https://careers.smartrecruiters.com/bigco' };

function rows(prefix, n, start = 0) {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}${start + i}`, name: `${prefix} role ${start + i}` }));
}

/**
 * Stub: `board(q, offset, facet)` returns { content, totalFound }. Records
 * every list request as { q, offset } (q = null for unfiltered), or
 * { facet, offset } when the experienceLevel facet is sent. By default the
 * stub behaves like the live API: the facet parameter is ignored.
 */
function stub(board, facetBoard = null) {
  const calls = [];
  const ctx = {
    transport: 'http',
    fetchText: async () => { throw new Error('fetchText should not be called'); },
    fetchJson: async (url) => {
      const u = new URL(url);
      assert.equal(u.hostname, 'api.smartrecruiters.com');
      if (/\/postings\/[^/]+$/.test(u.pathname)) {
        calls.push({ detail: u.pathname.split('/').pop() });
        return { jobAd: { sections: { jobDescription: { text: `<p>desc ${u.pathname.split('/').pop()}</p>` } } } };
      }
      const q = u.searchParams.get('q');
      const offset = parseInt(u.searchParams.get('offset') || '0', 10);
      const facet = u.searchParams.get('experienceLevel');
      if (facet !== null) {
        calls.push({ facet, offset });
        return facetBoard ? facetBoard(facet, offset) : board(null, offset);
      }
      calls.push({ q, offset });
      return board(q, offset);
    },
  };
  return { ctx, calls };
}

// 250-row board; per-term results below.
const TERM_ROWS = {
  intern: rows('A', 3),
  '"co-op"': [...rows('A', 1, 2), ...rows('B', 2)], // A2 duplicates intern's A2
  student: [],
};
function bigBoard(q, offset) {
  if (q === null) {
    const all = rows('F', 250);
    return { totalFound: 250, content: all.slice(offset, offset + 100) };
  }
  const list = TERM_ROWS[q] ?? [];
  return { totalFound: list.length, content: list.slice(offset, offset + 100) };
}

test('formatSearchTerm quotes multi-word and hyphenated terms only', () => {
  assert.equal(formatSearchTerm('intern'), 'intern');
  assert.equal(formatSearchTerm('co-op'), '"co-op"');
  assert.equal(formatSearchTerm(' summer analyst '), '"summer analyst"');
  assert.equal(formatSearchTerm('"early career"'), '"early career"');
});

test('parseKeywordConfig: absent / false / empty → no terms; min only when positive integer', () => {
  assert.deepEqual(parseKeywordConfig({}), { terms: [], minTotal: null });
  assert.deepEqual(parseKeywordConfig({ keywords: false }), { terms: [], minTotal: null });
  assert.deepEqual(parseKeywordConfig({ keywords: [], keyword_min_total: 10 }), { terms: [], minTotal: 10 });
  assert.deepEqual(parseKeywordConfig({ keywords: ['intern', ' ', 'Intern', 3, 'co-op'], keyword_min_total: 0 }),
    { terms: ['intern', 'co-op'], minTotal: null });
});

test('keywords absent → full board, no q, no marker', async () => {
  for (const keywords of [undefined, false, []]) {
    const { ctx, calls } = stub(bigBoard);
    const jobs = await sr.fetch({ ...BASE, keywords }, ctx);
    assert.equal(jobs.length, 250);
    assert.ok(calls.every((c) => c.q === null));
    assert.equal(calls.length, 3);
    assert.equal(jobs.keywordSearch, undefined);
    assert.equal(jobs.truncated, undefined);
    assert.equal('id' in jobs[0], false);
  }
});

test('board total ≤ keyword_min_total → full fetch, first page reused, no keyword requests', async () => {
  const { ctx, calls } = stub(bigBoard);
  const jobs = await sr.fetch({ ...BASE, keywords: ['intern', 'co-op'], keyword_min_total: 250 }, ctx);
  assert.equal(jobs.length, 250);
  assert.deepEqual(calls, [{ q: null, offset: 0 }, { q: null, offset: 100 }, { q: null, offset: 200 }]);
  assert.equal(jobs.keywordSearch, undefined);
});

test('board total > keyword_min_total → one walk per term, merged + deduped, marker set', async () => {
  const { ctx, calls } = stub(bigBoard);
  const jobs = await sr.fetch({ ...BASE, keywords: ['intern', 'co-op', 'student'], keyword_min_total: 100 }, ctx);
  assert.deepEqual(calls, [
    { q: null, offset: 0 },
    { q: 'intern', offset: 0 },
    { q: '"co-op"', offset: 0 },
    { q: 'student', offset: 0 },
  ]);
  assert.deepEqual(jobs.map((j) => j.title), ['A role 0', 'A role 1', 'A role 2', 'B role 0', 'B role 1']);
  assert.deepEqual(jobs.keywordSearch, {
    mode: 'keywords', terms: 3, boardTotal: 250, perTerm: { intern: 3, 'co-op': 3, student: 0 },
  });
  assert.equal(jobs.truncated, undefined);
  assert.equal('id' in jobs[0], false);
  assert.ok(jobs[0].url.startsWith('https://jobs.smartrecruiters.com/'));
});

test('a term hitting the page cap → truncated', async () => {
  const many = rows('M', 250);
  const { ctx, calls } = stub((q, offset) => (q === null
    ? { totalFound: 9999, content: rows('F', 100) }
    : { totalFound: q === 'intern' ? 250 : 0, content: q === 'intern' ? many.slice(offset, offset + 100) : [] }));
  const jobs = await sr.fetch({ ...BASE, keywords: ['intern', 'student'], keyword_min_total: 500, max_pages: 2 }, ctx);
  assert.equal(calls.filter((c) => c.q === 'intern').length, 2);
  assert.equal(jobs.length, 200);
  assert.equal(jobs.truncated, true);
  assert.deepEqual(jobs.keywordSearch.perTerm, { intern: 200, student: 0 });
});

test('unknown total with keywords → keyword search even with a min set', async () => {
  const { ctx, calls } = stub((q, offset) => (q === null
    ? { content: rows('F', 5) }
    : { content: offset === 0 ? rows('K', 2) : [] }));
  const jobs = await sr.fetch({ ...BASE, keywords: ['intern'], keyword_min_total: 1000 }, ctx);
  assert.deepEqual(calls, [{ q: null, offset: 0 }, { q: 'intern', offset: 0 }]);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.keywordSearch, { mode: 'keywords', terms: 1, boardTotal: null, perTerm: { intern: 2 } });
});

test('keywords without keyword_min_total → keyword search on a small board too', async () => {
  const { ctx, calls } = stub((q) => (q === null ? { totalFound: 3, content: rows('F', 3) } : { totalFound: 1, content: rows('K', 1) }));
  const jobs = await sr.fetch({ ...BASE, keywords: ['intern'] }, ctx);
  assert.equal(calls.length, 2);
  assert.equal(jobs.length, 1);
  assert.equal(jobs.keywordSearch.boardTotal, 3);
});

test('fetchDetails / detailLimit apply to the merged keyword result', async () => {
  const { ctx, calls } = stub(bigBoard);
  const jobs = await sr.fetch({
    ...BASE, keywords: ['intern', 'co-op'], keyword_min_total: 100,
    smartrecruiters: { fetchDetails: true, detailLimit: 4 },
  }, ctx);
  const details = calls.filter((c) => c.detail).map((c) => c.detail);
  assert.deepEqual(details.sort(), ['A0', 'A1', 'A2', 'B0']);
  assert.equal(jobs[3].description, 'desc B0');
  assert.equal(jobs[4].description, undefined);
  assert.ok(jobs.keywordSearch);
});

test('probing (ctx.maxPages) skips keyword search and reads one page', async () => {
  const { ctx, calls } = stub(bigBoard);
  const jobs = await sr.fetch({ ...BASE, keywords: ['intern'], keyword_min_total: 1 }, { ...ctx, maxPages: 1 });
  assert.deepEqual(calls, [{ q: null, offset: 0 }]);
  assert.equal(jobs.length, 100);
  assert.equal(jobs.keywordSearch, undefined);
});

// ── Platform facet (experienceLevel=internship) before keyword search ──
function taggedRows(prefix, n, start = 0) {
  return rows(prefix, n, start).map((r) => ({ ...r, experienceLevel: { id: 'internship', label: 'Internship' } }));
}

test('facetUsable: rejects ignored filter, empty, untagged rows; accepts a real filtered page', () => {
  const facet = { name: 'experienceLevel', values: ['internship'] };
  assert.equal(facetUsable({ totalFound: 250, content: rows('F', 100) }, 250, facet), 'filter ignored');
  assert.equal(facetUsable({ totalFound: 0, content: [] }, 250, facet), 'empty');
  assert.equal(facetUsable({ content: taggedRows('I', 2) }, 250, facet), 'no totalFound');
  assert.equal(facetUsable({ totalFound: 2, content: rows('F', 2) }, 250, facet), 'rows not tagged');
  assert.equal(facetUsable({ totalFound: 2, content: taggedRows('I', 2) }, 250, facet), null);
  assert.equal(facetUsable({ totalFound: 2, content: taggedRows('I', 2) }, null, facet), null);
});

test('facet honoured by the API → facet rows, no keyword requests, mode facet', async () => {
  const intern = taggedRows('I', 130);
  const { ctx, calls } = stub(bigBoard, (_v, offset) => ({ totalFound: 130, content: intern.slice(offset, offset + 100) }));
  const jobs = await sr.fetch({ ...BASE, keywords: ['intern', 'co-op'], keyword_min_total: 100, facet: true }, ctx);
  assert.deepEqual(calls, [{ q: null, offset: 0 }, { facet: 'internship', offset: 0 }, { facet: 'internship', offset: 100 }]);
  assert.equal(jobs.length, 130);
  assert.deepEqual(jobs.keywordSearch, {
    mode: 'facet', facet: { name: 'experienceLevel', values: ['internship'] }, terms: 1, boardTotal: 250, perTerm: { internship: 130 },
  });
  assert.equal('perValue' in jobs.keywordSearch, false);
  assert.equal('id' in jobs[0], false);
  assert.equal('experienceLevel' in jobs[0], false); // job shape unchanged
});

test('facet request errors → fallback to keyword search', async () => {
  const { ctx, calls } = stub(bigBoard, () => { throw new Error('HTTP 400'); });
  const jobs = await sr.fetch({ ...BASE, keywords: ['intern'], keyword_min_total: 100, facet: true }, ctx);
  assert.deepEqual(calls, [{ q: null, offset: 0 }, { facet: 'internship', offset: 0 }, { q: 'intern', offset: 0 }]);
  assert.equal(jobs.length, 3);
  assert.equal(jobs.keywordSearch.mode, 'keywords');
  assert.equal(jobs.keywordSearch.facet, undefined);
  assert.match(jobs.keywordSearch.facetFallback, /^error: HTTP 400/);
});

for (const facet of [undefined, false]) {
  test(`entry.facet: ${facet} → no facet request, keyword search directly, no facetFallback`, async () => {
    const { ctx, calls } = stub(bigBoard, () => { throw new Error('facet must not be requested'); });
    const jobs = await sr.fetch({ ...BASE, keywords: ['intern'], keyword_min_total: 100, facet }, ctx);
    assert.deepEqual(calls, [{ q: null, offset: 0 }, { q: 'intern', offset: 0 }]);
    assert.deepEqual(jobs.keywordSearch, { mode: 'keywords', terms: 1, boardTotal: 250, perTerm: { intern: 3 } });
  });
}

test('entry.facet: true but the API ignores the filter → keywords with facetFallback', async () => {
  const { ctx, calls } = stub(bigBoard);
  const jobs = await sr.fetch({ ...BASE, keywords: ['intern'], keyword_min_total: 100, facet: true }, ctx);
  assert.deepEqual(calls, [{ q: null, offset: 0 }, { facet: 'internship', offset: 0 }, { q: 'intern', offset: 0 }]);
  assert.equal(jobs.keywordSearch.facetFallback, 'internship: filter ignored');
});

test('selectFacetValues: default internship only; facet_values words match enum ids and labels', () => {
  assert.deepEqual(selectFacetValues({}), ['internship']);
  assert.deepEqual(selectFacetValues({ facet_values: [] }), ['internship']);
  assert.deepEqual(selectFacetValues({ facet_values: 'internship' }), ['internship']);   // not an array → default
  assert.deepEqual(selectFacetValues({ facet_values: [' ', 7, null] }), ['internship']);
  assert.deepEqual(selectFacetValues({ facet_values: ['internship', 'entry'] }), ['internship', 'entry_level']);
  assert.deepEqual(selectFacetValues({ facet_values: ['Entry Level'] }), ['entry_level']);   // phrase spans the id's underscore
  assert.deepEqual(selectFacetValues({ facet_values: ['Mid-Senior'] }), ['mid_senior_level']);
  assert.deepEqual(selectFacetValues({ facet_values: ['intern'] }), []);   // whole word: not internship
  assert.deepEqual(selectFacetValues({ facet_values: ['nomatch'] }), []);
  assert.deepEqual(parseFacetValues({}), []);
  assert.deepEqual(parseFacetValues({ facet_values: ['Intern', ' intern ', 'co  op', 3] }), ['Intern', 'co op']);
});

test('facet_values selecting two values → one probe per value, results merged + deduped', async () => {
  const tag = (id) => (r) => ({ ...r, experienceLevel: { id } });
  const byValue = {
    internship: rows('I', 2).map(tag('internship')),
    entry_level: [...rows('E', 3).map(tag('entry_level'))],
  };
  const { ctx, calls } = stub(bigBoard, (v, offset) => ({ totalFound: byValue[v].length, content: byValue[v].slice(offset, offset + 100) }));
  const jobs = await sr.fetch({ ...BASE, keywords: ['intern'], keyword_min_total: 100, facet: true, facet_values: ['internship', 'entry'] }, ctx);
  assert.deepEqual(calls, [{ q: null, offset: 0 }, { facet: 'internship', offset: 0 }, { facet: 'entry_level', offset: 0 }]);
  assert.equal(jobs.length, 5);
  assert.deepEqual(jobs.keywordSearch.facet, { name: 'experienceLevel', values: ['internship', 'entry_level'] });
  assert.equal(jobs.keywordSearch.terms, 2);
  assert.deepEqual(jobs.keywordSearch.perTerm, { internship: 2, entry_level: 3 });
});

test('one probed value ignored by the API → whole facet unusable, keywords for the board', async () => {
  const { ctx, calls } = stub(bigBoard, (v, offset) => (v === 'internship'
    ? { totalFound: 1, content: rows('I', 1).map((r) => ({ ...r, experienceLevel: { id: 'internship' } })) }
    : bigBoard(null, offset)));
  const jobs = await sr.fetch({ ...BASE, keywords: ['intern'], keyword_min_total: 100, facet: true, facet_values: ['internship', 'entry'] }, ctx);
  assert.deepEqual(calls, [{ q: null, offset: 0 }, { facet: 'internship', offset: 0 }, { facet: 'entry_level', offset: 0 }, { q: 'intern', offset: 0 }]);
  assert.equal(jobs.keywordSearch.mode, 'keywords');
  assert.equal(jobs.keywordSearch.facetFallback, 'entry_level: filter ignored');
  assert.equal(jobs.length, 3);
});

test('rows carrying another level → unusable; no matching value → no probe', async () => {
  const facet = { name: 'experienceLevel', values: ['internship'] };
  assert.equal(facetUsable({ totalFound: 2, content: rows('S', 2).map((r) => ({ ...r, experienceLevel: { id: 'associate' } })) }, 250, facet), 'rows not tagged');
  const { ctx, calls } = stub(bigBoard, () => { throw new Error('no probe expected'); });
  const jobs = await sr.fetch({ ...BASE, keywords: ['intern'], keyword_min_total: 100, facet: true, facet_values: ['nomatch'] }, ctx);
  assert.ok(calls.every((c) => !('facet' in c)));
  assert.equal(jobs.keywordSearch.facetFallback, 'no facet value matches');
});

test('facetValueMatcher: whole words, optional plural / possessive, case-insensitive, literal metacharacters', () => {
  const m = facetValueMatcher(['intern', 'co-op', 'summer analyst', 'c++']);
  assert.equal(m('Intern'), true);
  assert.equal(m('INTERNS'), true);
  assert.equal(m("intern's program"), true);
  assert.equal(m('internship'), false);          // not a whole word
  assert.equal(m('internal'), false);
  assert.equal(m('international'), false);
  assert.equal(m('Co-op'), true);
  assert.equal(m('co_op'), true);                 // separators are interchangeable
  assert.equal(m('coop'), false);
  assert.equal(m('summer_analyst'), true);
  assert.equal(m('Summer Analysts'), true);
  assert.equal(m('summeranalyst'), false);
  assert.equal(m('c++ developer'), true);         // "+" is literal, not a quantifier
  assert.equal(m('c developer'), false);
  assert.equal(m(42), false);
});

test('facetValueMatcher: internal / international never count, even combined with a listed word', () => {
  const m = facetValueMatcher(['internal', 'international', 'intern']);
  assert.equal(m('Internal'), false);
  assert.equal(m('International'), false);
  assert.equal(m('International Intern'), true);  // still matches through the real word
});

test('facetValueMatcher: the value is cut to 200 characters before matching', () => {
  const m = facetValueMatcher(['intern']);
  assert.equal(m('x'.repeat(199) + ' intern'), false);   // the word starts after the cut
  assert.equal(m('x'.repeat(193) + ' intern'), true);    // ends exactly at 200
  assert.equal(m('intern ' + 'x'.repeat(500)), true);
});
