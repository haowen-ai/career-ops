// Incremental scans (career-journal plan 2026-11-14 v2): a caller that already has some listings passes
// ctx.isKnownListing(job). Workday then skips the per-posting detail GET for known placeholders, and Greenhouse
// reads the plain list and fetches bodies only for new postings. Both still return every listing.
//
// Run: node --test tests/providers/known-listings.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import workday, { parseWorkdayResponse } from '../../providers/workday.mjs';
import greenhouse from '../../providers/greenhouse.mjs';

const ENTRY = { name: 'CrowdStrike', careers_url: 'https://crowdstrike.wd5.myworkdayjobs.com/crowdstrikecareers' };
const JOB_BASE = 'https://crowdstrike.wd5.myworkdayjobs.com/crowdstrikecareers';
const CXS_BASE = 'https://crowdstrike.wd5.myworkdayjobs.com/wday/cxs/crowdstrike/crowdstrikecareers';
const PAGE0 = { total: 3, jobPostings: [
  { title: 'Finance Intern', externalPath: '/job/USA---Sunnyvale-CA/Finance-Intern_R100', locationsText: '3 Locations', postedOn: 'Posted Today' },
  { title: 'Data Intern', externalPath: '/job/USA---Austin-TX/Data-Intern_R101-1', locationsText: '2 Locations', postedOn: 'Posted Today' },
  { title: 'Writer Intern', externalPath: '/job/USA---Austin-TX/Writer-Intern_R102', locationsText: 'USA - Austin, TX', postedOn: 'Posted Today' },
] };
const DETAIL = { jobPostingInfo: { location: 'USA - Sunnyvale, CA', additionalLocations: ['USA - Austin, TX'], startDate: '2026-09-04' } };
const mkCtx = (fetchJson, extra = {}) => ({ transport: 'http', workdayGate: null, fetchText: async () => { throw new Error('no fetchText'); }, fetchJson, sleep: async () => {}, ...extra });

test('workday rows carry the URL posting token as listingId (repost suffix kept)', () => {
  const jobs = parseWorkdayResponse(PAGE0, ENTRY);
  assert.deepEqual(jobs.map((job) => job.listingId), ['R100', 'R101-1', 'R102']);
  assert.equal(jobs[0].externalId, undefined, 'externalId stays unset (no posting id in the list API)');
  const again = parseWorkdayResponse({ jobPostings: [PAGE0.jobPostings[0]] }, ENTRY);
  assert.equal(again[0].listingId, jobs[0].listingId, 'the same posting read by another search has the same id');
  const tokenless = parseWorkdayResponse({ jobPostings: [{ title: 'Intern', externalPath: '/job/Remote/Data_Scientist' }] }, ENTRY);
  assert.equal(tokenless[0].listingId, undefined, 'no requisition-shaped token: no listingId (the caller falls back to the URL)');
});

test('workday skips the detail GET of known placeholders and still returns every posting', async () => {
  const details = [];
  const jobs = await workday.fetch(ENTRY, mkCtx(async (url) => {
    if (url.endsWith('/jobs')) return PAGE0;
    details.push(url);
    return DETAIL;
  }, { isKnownListing: (job) => job.listingId === 'R100' }));
  assert.equal(jobs.length, 3);
  assert.deepEqual(details, [`${CXS_BASE}/job/USA---Austin-TX/Data-Intern_R101-1`]);
  assert.equal(jobs.find((job) => job.listingId === 'R100').location, '3 Locations', 'a known placeholder is left as listed');
});

test('workday without isKnownListing resolves every placeholder as before', async () => {
  const details = [];
  await workday.fetch(ENTRY, mkCtx(async (url) => { if (url.endsWith('/jobs')) return PAGE0; details.push(url); return DETAIL; }));
  assert.equal(details.length, 2);
});

const GH_ENTRY = { name: 'Acme', api: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true' };
const ghJob = (id, extra = {}) => ({ id, title: `Data Intern ${id}`, absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`, location: { name: 'Chicago, IL' }, requisition_id: 'R-7', first_published: '2026-11-01T00:00:00Z', ...extra });

test('greenhouse with known listings reads the plain list and fetches bodies only for new postings', async () => {
  const urls = [];
  const jobs = await greenhouse.fetch(GH_ENTRY, mkCtx(async (url) => {
    urls.push(url);
    if (url === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs') return { jobs: [ghJob(1), ghJob(2), ghJob(3)] };
    if (url === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/3') return { ...ghJob(3), content: '&lt;p&gt;Summer 2027 internship&lt;/p&gt;' };
    throw new Error(`unexpected ${url}`);
  }, { isKnownListing: (job) => ['1', '2'].includes(job.listingIdentity?.posting_id) }));
  assert.deepEqual(urls, ['https://boards-api.greenhouse.io/v1/boards/acme/jobs', 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/3']);
  assert.equal(jobs.length, 3, 'every listing is returned');
  assert.match(jobs.find((job) => job.externalId === '3').description, /Summer 2027 internship/);
  assert.equal(jobs.find((job) => job.externalId === '1').description, undefined);
});

test('greenhouse falls back to content=true when more new postings than the detail limit', async () => {
  const urls = [];
  const many = Array.from({ length: 4 }, (_, i) => ghJob(i + 1));
  const jobs = await greenhouse.fetch({ ...GH_ENTRY, greenhouse: { detailLimit: 2 } }, mkCtx(async (url) => {
    urls.push(url);
    if (url === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs') return { jobs: many };
    if (url === GH_ENTRY.api) return { jobs: many.map((job) => ({ ...job, content: 'body', offices: [] })) };
    throw new Error(`unexpected ${url}`);
  }, { isKnownListing: () => false }));
  assert.deepEqual(urls, ['https://boards-api.greenhouse.io/v1/boards/acme/jobs', GH_ENTRY.api]);
  assert.equal(jobs.length, 4);
  assert.ok(jobs.every((job) => job.description === 'body'));
});

test('greenhouse without isKnownListing reads content=true as before', async () => {
  const urls = [];
  await greenhouse.fetch(GH_ENTRY, mkCtx(async (url) => { urls.push(url); return { jobs: [{ ...ghJob(1), content: 'x', offices: [] }] }; }));
  assert.deepEqual(urls, [GH_ENTRY.api]);
});
