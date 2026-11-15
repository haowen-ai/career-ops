// Early stop with a completion boundary (career-journal plan 2026-11-14 v3.1, step 8'). Only Oracle Cloud and Taleo,
// whose lists are requested newest-first, may stop paging early, and only when the caller passes both
// ctx.isKnownListing and ctx.earlyStopBeforeMs (its watermark minus a margin). A page stops the walk only when its last
// row is dated before that bound, every row on the page is known, and the dates read so far never went up (which
// proves the list is really ordered by the date the stop uses). Every walk reports
// jobs.collection = { status: complete | early_stopped | page_failed | ceiling }.
//
// Run: node --test tests/providers/early-stop.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import oracle, { buildApiUrl } from '../../providers/oraclecloud.mjs';
import taleo, { buildSearchBody } from '../../providers/taleo.mjs';
import { createEarlyStop, combineCollection } from '../../providers/_early-stop.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-14T00:00:00Z');
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();
const BOUND = NOW - 10 * DAY; // watermark − margin

// ── Oracle fixtures ──
const O_ENTRY = { name: 'Acme', careers_url: 'https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/requisitions' };
const O_JOB = (id) => `https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/${id}`;
const oPage = (rows, total = 600) => ({ items: [{ TotalJobsCount: total, requisitionList: rows.map(([id, days]) => ({ Id: id, Title: `Intern ${id}`, PrimaryLocation: 'Chicago, IL', ...(days == null ? {} : { PostedDate: daysAgo(days) }) })) }] });
const oCtx = (pages, extra = {}) => {
  const asked = [];
  return { asked, ctx: { sleep: async () => {}, fetchJson: async (url) => {
    const offset = Number(new URL(url).searchParams.get('offset'));
    asked.push(offset);
    const page = pages[offset / 200];
    if (page instanceof Error) throw page;
    return page ?? oPage([]);
  }, ...extra } };
};
const knownIds = (ids) => (job) => ids.some((id) => job.url === O_JOB(id));

test('createEarlyStop: stops only on an ordered, fully known page whose last row is dated before the bound', () => {
  const stop = createEarlyStop({ isKnownListing: () => true, earlyStopBeforeMs: BOUND });
  assert.equal(stop.page([{ postedAt: NOW - DAY }]), false, 'recent rows: keep reading');
  assert.equal(stop.page([{ postedAt: NOW - 20 * DAY }, { url: 'x' }]), false, 'a last row without a date never stops');
  assert.equal(stop.page([{ postedAt: NOW - 21 * DAY }]), true);
  const unordered = createEarlyStop({ isKnownListing: () => true, earlyStopBeforeMs: BOUND });
  assert.equal(unordered.page([{ postedAt: NOW - 30 * DAY }, { postedAt: NOW - 20 * DAY }]), false, 'a date that goes up proves the list is not in date order');
  assert.equal(unordered.page([{ postedAt: NOW - 40 * DAY }]), false, 'and the stop stays off for the rest of the walk');
  const partlyKnown = createEarlyStop({ isKnownListing: (job) => job.known, earlyStopBeforeMs: BOUND });
  assert.equal(partlyKnown.page([{ postedAt: NOW - 30 * DAY, known: true }, { postedAt: NOW - 31 * DAY, known: false }]), false, 'a new id on the page keeps reading');
  assert.equal(createEarlyStop({ isKnownListing: () => true }), null, 'no bound: no early stop');
  assert.equal(createEarlyStop({ earlyStopBeforeMs: BOUND }), null, 'no known listings: no early stop');
  assert.deepEqual(combineCollection(['complete', 'early_stopped']), 'early_stopped');
  assert.deepEqual(combineCollection(['early_stopped', 'ceiling']), 'ceiling');
  assert.deepEqual(combineCollection(['ceiling', 'page_failed']), 'page_failed');
  assert.deepEqual(combineCollection([]), 'complete');
});

test('the Oracle request sorts by posting date, the same field the stop reads (PostedDate → postedAt)', async () => {
  assert.match(buildApiUrl({ host: 'acme.fa.us2.oraclecloud.com', siteNumber: 'CX_1' }, 0), /sortBy=POSTING_DATES_DESC/);
  const { ctx } = oCtx([oPage([[1, 3]])], {});
  const [job] = await oracle.fetch(O_ENTRY, ctx);
  assert.equal(job.postedAt, Date.parse(daysAgo(3)));
});

test('Oracle stops after the first fully known page older than the bound; later pages are not read', async () => {
  const { asked, ctx } = oCtx([oPage([[1, 1], [2, 2]]), oPage([[3, 15], [4, 16]]), oPage([[5, 30]])], { isKnownListing: knownIds([3, 4, 5]), earlyStopBeforeMs: BOUND });
  const jobs = await oracle.fetch(O_ENTRY, ctx);
  assert.deepEqual(asked, [0, 200]);
  assert.equal(jobs.length, 4);
  assert.equal(jobs.collection.status, 'early_stopped');
  assert.equal(jobs.truncated, undefined, 'an early stop is not a truncation');
});

test('Oracle without a watermark reads everything and reports complete', async () => {
  const { asked, ctx } = oCtx([oPage([[1, 1]]), oPage([[3, 15]]), oPage([[5, 30]])], { isKnownListing: () => true });
  const jobs = await oracle.fetch(O_ENTRY, ctx);
  assert.deepEqual(asked, [0, 200, 400]);
  assert.equal(jobs.collection.status, 'complete');
});

test('Oracle: a refreshed old posting sorts first and does not stop the walk; the new id behind it is read', async () => {
  const { asked, ctx } = oCtx([oPage([[3, 0]]), oPage([[9, 2]]), oPage([[4, 20]])], { isKnownListing: knownIds([3, 4]), earlyStopBeforeMs: BOUND });
  const jobs = await oracle.fetch(O_ENTRY, ctx);
  assert.ok(jobs.some((job) => job.url === O_JOB(9)));
  assert.deepEqual(asked, [0, 200, 400]);
  assert.equal(jobs.collection.status, 'early_stopped');
});

test('Oracle: a new id on an old page prevents the stop (a page that failed last night is read again)', async () => {
  const { asked, ctx } = oCtx([oPage([[1, 1]]), oPage([[3, 15], [8, 16]]), oPage([[5, 30]])], { isKnownListing: knownIds([1, 3, 5]), earlyStopBeforeMs: BOUND });
  const jobs = await oracle.fetch(O_ENTRY, ctx);
  assert.ok(jobs.some((job) => job.url === O_JOB(8)));
  assert.deepEqual(asked, [0, 200, 400]);
});

test('Oracle: dates that go up (an unsorted tenant) disable the stop for the rest of the walk', async () => {
  const { asked, ctx } = oCtx([oPage([[1, 1]]), oPage([[2, 20], [3, 12]]), oPage([[7, 25]])], { isKnownListing: knownIds([2, 3]), earlyStopBeforeMs: BOUND });
  const jobs = await oracle.fetch(O_ENTRY, ctx);
  assert.deepEqual(asked, [0, 200, 400]);
  assert.ok(jobs.some((job) => job.url === O_JOB(7)));
  assert.equal(jobs.collection.status, 'complete');
});

test('Oracle: same-day rows split across pages inside the margin are all read', async () => {
  const { asked, ctx } = oCtx([oPage([[1, 1]]), oPage([[2, 2], [3, 2]]), oPage([[7, 2], [4, 30]])], { isKnownListing: knownIds([2, 3, 4]), earlyStopBeforeMs: BOUND });
  const jobs = await oracle.fetch(O_ENTRY, ctx);
  assert.deepEqual(asked, [0, 200, 400]);
  assert.ok(jobs.some((job) => job.url === O_JOB(7)));
});

test('Oracle: rows without a date never trigger the stop', async () => {
  const { asked, ctx } = oCtx([oPage([[1, 1]]), oPage([[3, null], [4, null]]), oPage([[5, 30]])], { isKnownListing: knownIds([3, 4, 5]), earlyStopBeforeMs: BOUND });
  await oracle.fetch(O_ENTRY, ctx);
  assert.deepEqual(asked, [0, 200, 400]);
});

test('Oracle: a later page that fails fails the list (no completion status to advance a watermark)', async () => {
  const { ctx } = oCtx([oPage([[1, 1]]), Object.assign(new Error('HTTP 404'), { status: 404 })], { isKnownListing: () => false, earlyStopBeforeMs: BOUND });
  await assert.rejects(oracle.fetch(O_ENTRY, ctx));
});

test('Oracle: the page ceiling reports ceiling and a truncation', async () => {
  const { ctx } = oCtx([oPage([[1, 1]]), oPage([[2, 2]]), oPage([[3, 3]])], {});
  const jobs = await oracle.fetch({ ...O_ENTRY, max_pages: 2 }, ctx);
  assert.equal(jobs.collection.status, 'ceiling');
  assert.ok(jobs.truncated);
});

// ── Taleo fixtures ──
const T_ENTRY = { name: 'Bank', careers_url: 'https://bank.taleo.net/careersection/ex/jobsearch.ftl', us_only: false };
const fmt = (days) => new Date(NOW - days * DAY).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const tPage = (rows, total = 75) => ({ requisitionList: rows.map(([id, days]) => ({ contestNo: `J${id}`, linkedColumn: 0, locationsColumns: [1], column: [`Intern ${id}`, 'Chicago, IL', days == null ? '' : fmt(days)] })), pagingData: { totalCount: total } });
const tUrl = (id) => `https://bank.taleo.net/careersection/ex/jobdetail.ftl?job=J${id}&lang=en`;
const tCtx = (pages, extra = {}) => {
  const asked = [];
  return { asked, ctx: { sleep: async () => {}, fetchJson: async (_url, opts) => {
    const pageNo = JSON.parse(opts.body).pageNo;
    asked.push(pageNo);
    const page = pages[pageNo - 1];
    if (page instanceof Error) throw page;
    return page ?? tPage([]);
  }, ...extra } };
};

test('the Taleo request sorts newest first and the row date is what the stop reads', async () => {
  const body = JSON.parse(buildSearchBody({ keyword: '' }, 1, null));
  assert.deepEqual(body.sortingSelection, { sortBySelectionParam: '3', ascendingSortingOrder: 'false' });
  const { ctx } = tCtx([tPage([[1, 3]], 1)]);
  const [job] = await taleo.fetch(T_ENTRY, ctx);
  assert.equal(job.postedAt, Date.UTC(...(() => { const d = new Date(NOW - 3 * DAY); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]; })()));
});

test('Taleo: a later page that fails is page_failed and a truncation, not a quiet short list', async () => {
  const { ctx } = tCtx([tPage([[1, 1]]), Object.assign(new Error('HTTP 404'), { status: 404 })]);
  const jobs = await taleo.fetch(T_ENTRY, ctx);
  assert.equal(jobs.collection.status, 'page_failed');
  assert.equal(jobs.truncated?.reason, 'page-failed');
});

test('Taleo stops early on a fully known old page and reports early_stopped', async () => {
  const { asked, ctx } = tCtx([tPage([[1, 1]]), tPage([[2, 20]]), tPage([[3, 30]])], { isKnownListing: (job) => [tUrl(2), tUrl(3)].includes(job.url), earlyStopBeforeMs: BOUND });
  const jobs = await taleo.fetch(T_ENTRY, ctx);
  assert.deepEqual(asked, [1, 2]);
  assert.equal(jobs.collection.status, 'early_stopped');
});

test('Taleo without a watermark reads to the end and reports complete', async () => {
  const { asked, ctx } = tCtx([tPage([[1, 1]]), tPage([[2, 20]]), tPage([[3, 30]])]);
  const jobs = await taleo.fetch(T_ENTRY, ctx);
  assert.deepEqual(asked, [1, 2, 3]);
  assert.equal(jobs.collection.status, 'complete');
});

test('Taleo: a repeated page before the known total is page_failed, never complete (Codex review 11/15)', async () => {
  // The API hands back page 1 again for page 2: only 1 of 75 postings read. Advancing a watermark here would hide the rest.
  const { ctx } = tCtx([tPage([[1, 1]]), tPage([[1, 1]])]);
  const jobs = await taleo.fetch(T_ENTRY, ctx);
  assert.equal(jobs.collection.status, 'page_failed');
  assert.equal(jobs.truncated?.reason, 'repeated-page');
});

test('Taleo: a repeated page with an unknown total is not complete either', async () => {
  const { ctx } = tCtx([tPage([[1, 1]], null), tPage([[1, 1]], null)]);
  const jobs = await taleo.fetch(T_ENTRY, ctx);
  assert.notEqual(jobs.collection.status, 'complete');
  assert.notEqual(jobs.collection.status, 'early_stopped');
});
