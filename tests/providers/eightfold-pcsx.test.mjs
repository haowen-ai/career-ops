// tests/providers/eightfold-pcsx.test.mjs — PCSX fallback of providers/eightfold.mjs.
// Run: node --test tests/providers/eightfold-pcsx.test.mjs  (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = await import(pathToFileURL(join(ROOT, 'providers/eightfold.mjs')).href);
const ef = mod.default;
const { parsePcsxResponse, buildPcsxUrl, extractDomainFromPage, resolveMode, resolvePcsxFilters, resolvePcsxLocation } = mod;
const fixture = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/eightfold-pcsx-search.json'), 'utf8'));
const tenant = { host: 'acme.eightfold.ai', domain: 'acme.com' };

function http403() { const e = new Error('HTTP 403 Forbidden'); e.status = 403; return e; }

/** ctx routing v2 / pcsx / careers page by path. */
function mockCtx({ v2, pcsx, page = '' }) {
  const calls = [];
  return {
    calls,
    ctx: {
      transport: 'http',
      sleep: async () => {},
      fetchText: async (url) => { calls.push(url); return page; },
      fetchJson: async (url) => {
        calls.push(url);
        const u = new URL(url);
        if (u.pathname === '/api/apply/v2/jobs') return v2(u);
        if (u.pathname === '/api/pcsx/search') return pcsx(u);
        throw new Error(`unexpected ${url}`);
      },
    },
  };
}

test('parsePcsxResponse keeps good rows and skips malformed ones', () => {
  const { jobs, rawCount, total } = parsePcsxResponse(fixture, tenant, 'Acme');
  assert.equal(rawCount, 7);
  assert.equal(total, 7);
  assert.deepEqual(jobs.map((j) => j.title), ['Advanced Systems Analyst (Nashville, TN)', 'Finance Intern', 'Hostile URL']);
  const [a, b, c] = jobs;
  assert.equal(a.url, 'https://acme.eightfold.ai/careers/job/481079465435?domain=acme.com');
  assert.equal(a.id, '481079465435');
  assert.equal(a.location, 'United States · Nashville, Tennessee, United States');
  assert.equal(a.postedAt, 1784048558000);
  assert.equal(b.url, 'https://acme.eightfold.ai/careers/job/481079465436?domain=acme.com');
  assert.equal(b.postedAt, 1783987989000);
  // protocol-relative positionUrl is never followed; falls back to the pinned host
  assert.equal(new URL(c.url).hostname, 'acme.eightfold.ai');
  assert.equal(c.location, 'Austin, Texas, United States');
});

test('parsePcsxResponse throws on error envelopes and bad shapes', () => {
  assert.throws(() => parsePcsxResponse(null, tenant, 'Acme'), /not a JSON object/);
  assert.throws(() => parsePcsxResponse([], tenant, 'Acme'), /not a JSON object/);
  assert.throws(() => parsePcsxResponse({ status: 500, error: { message: 'boom' } }, tenant, 'Acme'), /envelope status 500/);
  assert.throws(() => parsePcsxResponse({ status: 200, error: { message: 'Not authorized' }, data: { positions: [] } }, tenant, 'Acme'), /error envelope: Not authorized/);
  assert.throws(() => parsePcsxResponse({ messages: { domain: ['Missing data for required field.'] } }, tenant, 'Acme'), /request rejected/);
  assert.throws(() => parsePcsxResponse({ status: 200, error: { message: '' } }, tenant, 'Acme'), /no data object/);
  assert.throws(() => parsePcsxResponse({ status: 200, data: { positions: {} } }, tenant, 'Acme'), /not an array/);
  const empty = parsePcsxResponse({ status: 200, error: { message: '' }, data: { positions: [], count: 0 } }, tenant, 'Acme');
  assert.deepEqual(empty.jobs, []);
});

test('buildPcsxUrl sets domain, US location and repeated filters', () => {
  const u = new URL(buildPcsxUrl(tenant, 20, { location: 'United States', filters: [['job_category', 'technology'], ['job_category', 'finance']] }));
  assert.equal(u.hostname, 'acme.eightfold.ai');
  assert.equal(u.pathname, '/api/pcsx/search');
  assert.equal(u.searchParams.get('domain'), 'acme.com');
  assert.equal(u.searchParams.get('start'), '20');
  assert.equal(u.searchParams.get('num'), '10');
  assert.equal(u.searchParams.get('location'), 'United States');
  assert.deepEqual(u.searchParams.getAll('filter_job_category'), ['technology', 'finance']);
});

test('entry option validation', () => {
  assert.equal(resolveMode({}), 'auto');
  assert.equal(resolveMode({ eightfold_mode: 'pcsx' }), 'pcsx');
  assert.throws(() => resolveMode({ name: 'X', eightfold_mode: 'v3' }), /unknown eightfold_mode/);
  assert.equal(resolvePcsxLocation({}), 'United States');
  assert.equal(resolvePcsxLocation({ location: 'any' }), null);
  assert.throws(() => resolvePcsxFilters({ filters: ['x'] }), /mapping/);
  assert.throws(() => resolvePcsxFilters({ filters: { 'bad key&': 'x' } }), /invalid filter key/);
  assert.throws(() => resolvePcsxFilters({ filters: { job_category: [3] } }), /non-empty string/);
  assert.deepEqual(resolvePcsxFilters({ filters: { job_category: ['a', 'b'] } }), [['job_category', 'a'], ['job_category', 'b']]);
});

test('extractDomainFromPage reads raw and HTML-escaped config', () => {
  assert.equal(extractDomainFromPage('<script>{"domain": "starbucks.com", "x": 1}</script>'), 'starbucks.com');
  assert.equal(extractDomainFromPage('data-x="{&#34;domain&#34;: &#34;circana.com&#34;}"'), 'circana.com');
  assert.equal(extractDomainFromPage('<html>no config</html>'), null);
});

test('fetch falls back from v2 403 to PCSX and pages until short page', async () => {
  const page0 = { status: 200, error: { message: '' }, data: { count: 12, positions: Array.from({ length: 10 }, (_, i) => ({ id: 100 + i, name: `Job ${i}`, positionUrl: `/careers/job/${100 + i}` })) } };
  const page1 = { status: 200, error: { message: '' }, data: { count: 12, positions: [{ id: 200, name: 'Job 10' }, { id: 201, name: 'Job 11' }] } };
  const { ctx, calls } = mockCtx({ v2: () => { throw http403(); }, pcsx: (u) => (u.searchParams.get('start') === '0' ? page0 : page1) });
  const jobs = await ef.fetch({ name: 'Acme', careers_url: 'https://acme.eightfold.ai/careers?domain=acme.com' }, ctx);
  assert.equal(jobs.length, 12);
  assert.equal(calls.filter((c) => c.includes('/api/apply/v2/')).length, 1);
  assert.equal(calls.filter((c) => c.includes('/api/pcsx/')).length, 2);
  for (const c of calls) assert.equal(new URL(c).hostname, 'acme.eightfold.ai');
  assert.equal(new URL(calls[1]).searchParams.get('location'), 'United States');
});

test('fetch derives the domain from the careers page when the entry has none', async () => {
  const { ctx, calls } = mockCtx({
    v2: () => { throw new Error('v2 must not be called in pcsx mode'); },
    pcsx: () => ({ status: 200, error: { message: '' }, data: { count: 1, positions: [{ id: 1, name: 'Only' }] } }),
    page: '<div data-c="{&#34;domain&#34;: &#34;acme.com&#34;}"></div>',
  });
  const jobs = await ef.fetch({ name: 'Acme', careers_url: 'https://acme.eightfold.ai/careers', eightfold_mode: 'pcsx' }, ctx);
  assert.equal(jobs.length, 1);
  assert.equal(calls[0], 'https://acme.eightfold.ai/careers');
  assert.equal(new URL(calls[1]).searchParams.get('domain'), 'acme.com');
});

test('auto mode: v2 403 then PCSX derives the domain from the careers page when the entry has none', async () => {
  const { ctx, calls } = mockCtx({
    v2: () => { throw http403(); },
    pcsx: (u) => (u.searchParams.get('domain') === 'acme.com'
      ? { status: 200, error: { message: '' }, data: { count: 1, positions: [{ id: 1, name: 'Only' }] } }
      : (() => { const e = new Error('HTTP 422 Missing domain'); e.status = 422; throw e; })()),
    page: '<div data-c="{&#34;domain&#34;: &#34;acme.com&#34;}"></div>',
  });
  const jobs = await ef.fetch({ name: 'Acme', careers_url: 'https://acme.eightfold.ai/careers' }, ctx);
  assert.equal(jobs.length, 1);
  assert.ok(calls.includes('https://acme.eightfold.ai/careers'));
  assert.equal(new URL(calls.find((c) => c.includes('/api/pcsx/'))).searchParams.get('domain'), 'acme.com');
});

test('auto mode: an unreadable careers page still probes PCSX without a domain', async () => {
  const { ctx, calls } = mockCtx({
    v2: () => { throw http403(); },
    pcsx: () => ({ status: 200, error: { message: '' }, data: { count: 1, positions: [{ id: 1, name: 'Only' }] } }),
    page: '<html></html>',
  });
  const jobs = await ef.fetch({ name: 'Acme', careers_url: 'https://acme.eightfold.ai/careers' }, ctx);
  assert.equal(jobs.length, 1);
  assert.equal(new URL(calls.find((c) => c.includes('/api/pcsx/'))).searchParams.get('domain'), null);
});

test('fetch throws (no silent empty) when the page has no domain', async () => {
  const { ctx } = mockCtx({ v2: () => ({}), pcsx: () => ({}), page: '<html></html>' });
  await assert.rejects(ef.fetch({ name: 'Acme', careers_url: 'https://acme.eightfold.ai/careers', eightfold_mode: 'pcsx' }, ctx), /no domain/);
});

test('v2 403 is not swallowed in v2 mode, and non-403 errors do not fall back', async () => {
  const { ctx } = mockCtx({ v2: () => { throw http403(); }, pcsx: () => { throw new Error('pcsx must not be called'); } });
  await assert.rejects(ef.fetch({ name: 'Acme', careers_url: 'https://acme.eightfold.ai/careers?domain=acme.com', eightfold_mode: 'v2' }, ctx), /403/);
  const { ctx: ctx2 } = mockCtx({ v2: () => { const e = new Error('HTTP 404'); e.status = 404; throw e; }, pcsx: () => { throw new Error('pcsx must not be called'); } });
  await assert.rejects(ef.fetch({ name: 'Acme', careers_url: 'https://acme.eightfold.ai/careers?domain=acme.com' }, ctx2), /404/);
});

test('PCSX error envelope mid-fetch throws', async () => {
  const { ctx } = mockCtx({ v2: () => { throw http403(); }, pcsx: () => ({ status: 403, error: { message: 'Forbidden' } }) });
  await assert.rejects(ef.fetch({ name: 'Acme', careers_url: 'https://acme.eightfold.ai/careers?domain=acme.com' }, ctx), /envelope status 403|neither API is readable/); // auto mode: upstream's PCSX probe reports it
});

test('PCSX 429 burst limit: cooldown then resume, page delay raised; bounded', async () => {
  const { RATE_LIMIT_COOLDOWN_MS, RATE_LIMIT_RETRIES } = mod;
  const slept = [];
  let n = 0;
  const limited = new Set([3, 4, 5, 6]); // requests 3..6 hit the limit (generic retries included)
  const pos = (s) => Array.from({ length: 10 }, (_, i) => ({ id: s + i, name: `Job ${s + i}` }));
  const ctx = {
    sleep: async (ms) => { slept.push(ms); },
    fetchText: async () => '',
    fetchJson: async (url) => {
      n++;
      if (limited.has(n)) { const e = new Error('HTTP 429'); e.status = 429; throw e; }
      const start = Number(new URL(url).searchParams.get('start'));
      return { status: 200, error: { message: '' }, data: { count: 30, positions: start < 30 ? pos(start) : [] } };
    },
  };
  const jobs = await ef.fetch({ name: 'Acme', careers_url: 'https://acme.eightfold.ai/careers?domain=acme.com', eightfold_mode: 'pcsx' }, ctx);
  assert.equal(jobs.length, 30);
  assert.ok(slept.includes(RATE_LIMIT_COOLDOWN_MS), `cooldown not applied: ${slept}`);
  assert.ok(slept.at(-1) >= 1000, `page delay not raised: ${slept}`);

  // a limit that never lifts is rethrown after RATE_LIMIT_RETRIES cooldowns
  let calls = 0;
  const stuck = {
    sleep: async () => {},
    fetchText: async () => '',
    fetchJson: async () => { calls++; const e = new Error('HTTP 429'); e.status = 429; throw e; },
  };
  await assert.rejects(ef.fetch({ name: 'Acme', careers_url: 'https://acme.eightfold.ai/careers?domain=acme.com', eightfold_mode: 'pcsx' }, stuck), /429/);
  assert.equal(calls, (RATE_LIMIT_RETRIES + 1) * 3); // 3 = one try + 2 generic retries per cooldown round
});

test('PCSX query option is validated and forwarded', async () => {
  const { resolvePcsxQuery } = mod;
  assert.equal(resolvePcsxQuery({}), null);
  assert.equal(resolvePcsxQuery({ query: ' intern ' }), 'intern');
  assert.throws(() => resolvePcsxQuery({ query: '' }), /query/);
  assert.throws(() => resolvePcsxQuery({ query: ['x'] }), /query/);
  assert.equal(new URL(buildPcsxUrl(tenant, 0, { query: 'intern' })).searchParams.get('query'), 'intern');
  const { ctx, calls } = mockCtx({ v2: () => { throw http403(); }, pcsx: () => ({ status: 200, error: { message: '' }, data: { count: 1, positions: [{ id: 1, name: 'Research Intern' }] } }) });
  await ef.fetch({ name: 'Acme', careers_url: 'https://acme.eightfold.ai/careers?domain=acme.com', eightfold_mode: 'pcsx', query: 'intern' }, ctx);
  assert.equal(new URL(calls[0]).searchParams.get('query'), 'intern');
});
