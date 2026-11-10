// tests/providers/bestbuy.test.mjs — Best Buy careers (ServiceNow Service
// Portal widget on jobs.bestbuy.com).
//
// The fixture is a trimmed live widget response (2026-11-07, 3 of 2,441 US
// rows). No network is used — ctx is stubbed.
//
// Run:  node --test tests/providers/bestbuy.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/bestbuy.mjs')).href);
const bb = mod.default;
const { resolveConfig, buildBody, parseWidgetResponse, extractToken, cookieHeader } = mod;

const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/bestbuy-widget.json'), 'utf8'));
const URL_US = 'https://jobs.bestbuy.com/bby?id=all_jobs&country=US';
const ENTRY = { name: 'Acme', careers_url: URL_US };
const TOKEN = 'b2b62ea73bd41a5c0f0e3a5b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b';
const SHELL = `<html><script>var g_ck = '${TOKEN}';</script></html>`;

function page(n, start, total) {
  return {
    result: {
      data: {
        total_count: total,
        items: {
          features: Array.from({ length: n }, (_, i) => ({
            properties: { auto_req_id: `${start + i}BR`, title: `Job ${start + i}`, city: 'Richfield', state: 'Minnesota', country: 'United States' },
          })),
        },
      },
    },
  };
}

function makeCtx(bodies, extra = {}) {
  const calls = [];
  const gets = [];
  let i = 0;
  return {
    calls,
    gets,
    sleep: async () => {},
    fetchResponse: async (url, opts) => {
      gets.push({ url, opts });
      return { headers: { getSetCookie: () => ['JSESSIONID=ABC; Path=/', 'glide_user=; Max-Age=0', 'glide_user_route=glide.1'] }, text: async () => SHELL };
    },
    fetchJson: async (url, opts) => {
      calls.push({ url, opts });
      const b = bodies[i++];
      if (b instanceof Error) throw b;
      return b === undefined ? page(0, 1, 0) : b;
    },
    ...extra,
  };
}

test('id; detect() claims only https jobs.bestbuy.com', () => {
  assert.equal(bb.id, 'bestbuy');
  assert.deepEqual(bb.detect(ENTRY), { url: URL_US });
  for (const bad of ['http://jobs.bestbuy.com/bby', 'https://jobs.bestbuy.com.evil.example/', 'https://evil.example/bby', 'nope', '']) {
    assert.equal(bb.detect({ careers_url: bad }), null, bad);
  }
  assert.equal(bb.detect(null), null);
});

test('resolveConfig()/buildBody(): country → countrySTARTSWITH filter, offset paging', () => {
  const cfg = resolveConfig(ENTRY);
  assert.deepEqual(cfg.filters, { country: 'countrySTARTSWITHUS' });
  assert.equal(cfg.widgetUrl, 'https://jobs.bestbuy.com/api/now/sp/widget/dd786d721b71b010b4c011f18c4bcb87?id=all_jobs');
  assert.deepEqual(resolveConfig({ careers_url: 'https://jobs.bestbuy.com/bby?id=all_jobs&country=US%22)' }).filters, {});
  const b = JSON.parse(buildBody(cfg, 1000));
  assert.equal(b.action, 'update_data');
  assert.equal(b.options.lastLimit, 1000);
  assert.equal(b.options.items_per_page, 500);
  assert.equal(b.options.limitResults, 'limitResults');
  for (const bad of ['https://evil.example/bby', 'http://jobs.bestbuy.com/bby', 'nope']) {
    assert.throws(() => resolveConfig({ careers_url: bad }), undefined, bad);
  }
});

test('extractToken() / cookieHeader()', () => {
  assert.equal(extractToken(SHELL), TOKEN);
  assert.equal(extractToken('<html>no token</html>'), null);
  assert.equal(extractToken(null), null);
  assert.equal(cookieHeader(['JSESSIONID=A; Path=/', 'glide_user=; Max-Age=0', 'x']), 'JSESSIONID=A');
});

test('parseWidgetResponse(): real fixture rows', () => {
  const { rows, total, rawCount } = parseWidgetResponse(FIXTURE);
  assert.equal(total, 3);
  assert.equal(rawCount, 3);
  assert.equal(rows[0].title, 'Retail Sales Associate');
  assert.equal(rows[0].url, 'https://jobs.bestbuy.com/bby?id=job_details&req_id=1055582BR');
  assert.equal(rows[0].location, 'Fullerton, California');
});

test('parseWidgetResponse(): malformed rows skipped, entities decoded, non-US country kept', () => {
  const { rows } = parseWidgetResponse({
    result: {
      data: {
        total_count: 5,
        items: {
          features: [
            null,
            { properties: { auto_req_id: '1BR', title: '' } },
            { properties: { auto_req_id: 7, title: 'Numeric id' } },
            { properties: { auto_req_id: '../x?y', title: 'Bad id' } },
            { properties: { auto_req_id: '2BR', title: 'R&amp;D Intern', city: 'Toronto', state: { x: 1 }, country: 'Canada' } },
          ],
        },
      },
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'R&D Intern');
  assert.equal(rows[0].location, 'Toronto, Canada');
});

test('parseWidgetResponse(): zero → empty; invalid_token / envelopes / non-array → throw', () => {
  assert.equal(parseWidgetResponse(page(0, 1, 0)).rows.length, 0);
  assert.throws(() => parseWidgetResponse({ result: { action: 'update_data', invalid_token: true } }), /invalid_token/);
  assert.throws(() => parseWidgetResponse({ error: { message: 'User Not Authenticated' }, status: 'failure' }), /no result .*User Not Authenticated/);
  assert.throws(() => parseWidgetResponse({ result: { options: {} } }), /has no data/);
  assert.throws(() => parseWidgetResponse({ result: { data: { total_count: 1, items: { features: {} } } } }), /not an array/);
  assert.throws(() => parseWidgetResponse({ result: { data: { total_count: 1 } } }), /items\.features is missing/);
  assert.throws(() => parseWidgetResponse(null), /returned null/);
  assert.throws(() => parseWidgetResponse([]), /returned an array/);
});

test('fetch(): shell GET, then POST with X-UserToken + cookies + redirect:error', async () => {
  const ctx = makeCtx([FIXTURE]);
  const jobs = await bb.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 3);
  assert.deepEqual(Object.keys(jobs[0]).sort(), ['company', 'location', 'title', 'url']);
  assert.equal(ctx.gets.length, 1);
  assert.equal(ctx.gets[0].url, 'https://jobs.bestbuy.com/bby?id=all_jobs');
  assert.equal(ctx.gets[0].opts.redirect, 'error');
  const o = ctx.calls[0].opts;
  assert.equal(o.method, 'POST');
  assert.equal(o.redirect, 'error');
  assert.equal(o.headers['x-usertoken'], TOKEN);
  assert.equal(o.headers.cookie, 'JSESSIONID=ABC; glide_user_route=glide.1');
});

test('fetch(): host guard throws before any request; missing token throws', async () => {
  for (const careers_url of ['https://evil.example/bby', 'http://jobs.bestbuy.com/bby']) {
    const ctx = makeCtx([FIXTURE]);
    await assert.rejects(() => bb.fetch({ name: 'Acme', careers_url }, ctx));
    assert.equal(ctx.gets.length + ctx.calls.length, 0);
  }
  const ctx = makeCtx([FIXTURE], { fetchResponse: async () => ({ headers: { getSetCookie: () => ['JSESSIONID=A'] }, text: async () => '<html></html>' }) });
  await assert.rejects(() => bb.fetch(ENTRY, ctx), /no session token/);
  assert.equal(ctx.calls.length, 0);
});

test('fetch(): invalid_token envelope throws instead of returning []', async () => {
  await assert.rejects(() => bb.fetch(ENTRY, makeCtx([{ result: { invalid_token: true } }])), /invalid_token/);
});

test('fetch(): offset paging stops at total_count even after a short mid page', async () => {
  const ctx = makeCtx([page(500, 1, 1400), page(499, 501, 1400), page(400, 1001, 1400), page(10, 9000, 1400)]);
  const jobs = await bb.fetch(ENTRY, ctx);
  assert.equal(jobs.length, 1399);
  assert.deepEqual(ctx.calls.map((c) => JSON.parse(c.opts.body).options.lastLimit), [0, 500, 1000]);
});

test('fetch(): max_pages ceiling + warning; ctx.maxPages=1; probe error unwrapped; page-2 failure keeps page 1', async () => {
  const pages = Array.from({ length: 30 }, (_, p) => page(500, p * 500 + 1, 9_999_999));
  const warnings = [];
  const real = console.error;
  console.error = (m) => warnings.push(String(m));
  try {
    const ctx = makeCtx(pages);
    await bb.fetch(ENTRY, ctx);
    assert.equal(ctx.calls.length, 20);
    const ctx2 = makeCtx(pages);
    await bb.fetch({ ...ENTRY, max_pages: 2 }, ctx2);
    assert.equal(ctx2.calls.length, 2);
    assert.ok(warnings.some((w) => /raise max_pages/.test(w)));
    warnings.length = 0;
    const ctx3 = makeCtx(pages, { maxPages: 1 });
    assert.equal((await bb.fetch(ENTRY, ctx3)).length, 500);
    assert.equal(ctx3.calls.length, 1);
    assert.equal(warnings.length, 0);
    const busy = Object.assign(new Error('HTTP 503'), { status: 503 });
    assert.equal((await bb.fetch(ENTRY, makeCtx([page(500, 1, 2000), busy, busy, busy]))).length, 500);
    assert.ok(warnings.some((w) => /page 2 failed/.test(w)));
    assert.equal(warnings.filter((w) => /raise max_pages/.test(w)).length, 0);
  } finally {
    console.error = real;
  }
  class ProbePageBudgetReached extends Error {}
  const err = new ProbePageBudgetReached('budget');
  await assert.rejects(() => bb.fetch(ENTRY, makeCtx([err, err, err], { maxPages: 1 })), (e) => e === err);
});
