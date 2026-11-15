// Phenom one-session walk and collection status (career-journal plan 2026-11-14 v7b + r2).
//
// Live evidence 2026-11-15 (Allianz, DHL, Franklin Templeton): without a session cookie the same /widgets request
// alternates between two orderings, so paging by `from` reads some rows twice and others never (Allianz 1468 of 1704,
// DHL 7157 of 8291, Franklin Templeton 237 of 260) while the old provider still reported a complete board. With the
// first response's Set-Cookie sent on every later page, every page comes from one ordering: 1704/8291/260, no repeats.
// Every walk reports jobs.collection.status:
//   complete     every page reported the first page's totalHits, the distinct raw jobIds reached it, every row had a
//                jobId and no row was dropped by the parser;
//   page_failed  an empty page, a page of jobIds already read, the offsets ran past totalHits short of it, or a later
//                page's request failed (the rows already read are kept);
//   ceiling      max_pages (or ctx.maxPages) ran out first;
//   unverified   a page reported another totalHits, a row had no jobId, or a row with a jobId was dropped by the parser.
// No network — ctx is stubbed.
//
// Run:  node --test tests/providers/phenom-collection.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const phenom = (await import(pathToFileURL(join(ROOT, 'providers/phenom.mjs')).href)).default;

const ENTRY = { name: 'ExampleCo', careers_url: 'https://careers.exampleco.com' };
const job = (id, title = `Job ${id}`) => ({ jobId: id == null ? undefined : String(id), title, location: 'Berlin, Germany', postedDate: '2026-11-01T00:00:00.000+0000' });
const body = (jobs, totalHits) => ({ refineSearch: { status: 200, totalHits, data: { jobs } } });
const ids = (from, n) => Array.from({ length: n }, (_, i) => from + i);

// A Response-like object, as ctx.fetchResponse returns.
function response(json, setCookies = []) {
  return { status: 200, headers: { getSetCookie: () => setCookies }, json: async () => json, text: async () => JSON.stringify(json) };
}

async function quiet(fn) {
  const orig = console.error;
  const errors = [];
  console.error = (...a) => { errors.push(a.join(' ')); };
  try { return { result: await fn(), errors }; } finally { console.error = orig; }
}

// A backend with two orderings of the same rows (two replicas). A request without a session lands on B, A, B, ... in
// turn and is handed a session cookie naming the replica that served it; a request with that cookie stays on that
// replica (what the live tenants did).
function twoReplicaBackend(total) {
  const all = ids(1, total);
  const orders = { A: all, B: [...all].sort((x, y) => (x * 7919) % 1009 - (y * 7919) % 1009 || x - y) };
  let anonymous = 0;
  const requests = [];
  const page = (order, from) => body(order.slice(from, from + 100).map((id) => job(id)), total);
  return {
    requests,
    fetchResponse: async (url, opts) => {
      const req = JSON.parse(opts.body);
      const cookie = opts.headers?.cookie ?? null;
      requests.push({ from: req.from, cookie });
      const pinned = /PLAY_SESSION=s([AB])/.exec(cookie ?? '')?.[1];
      if (pinned) return response(page(orders[pinned], req.from));
      const replica = anonymous++ % 2 === 0 ? 'B' : 'A';
      return response(page(orders[replica], req.from), [`PLAY_SESSION=s${replica}; Path=/; Secure; HTTPOnly`, 'PHPPPE_ACT=a1; Path=/; Secure']);
    },
    fetchJsonOnly: async (url, opts) => {
      const req = JSON.parse(opts.body);
      requests.push({ from: req.from, cookie: null });
      return page(orders[anonymous++ % 2 === 0 ? 'B' : 'A'], req.from);
    },
  };
}

test('the first response\'s Set-Cookie is sent on every later page, so the walk reads every row once: complete', async () => {
  const be = twoReplicaBackend(450);
  const { result: jobs } = await quiet(() => phenom.fetch(ENTRY, { sleep: async () => {}, fetchResponse: be.fetchResponse }));
  assert.equal(be.requests.length, 5);
  assert.equal(be.requests[0].cookie, null);
  for (const r of be.requests.slice(1)) assert.equal(r.cookie, 'PLAY_SESSION=sB; PHPPPE_ACT=a1');
  assert.equal(jobs.length, 450);
  assert.equal(new Set(jobs.map((j) => j.url)).size, 450);
  assert.equal(jobs.collection.status, 'complete');
  assert.equal(jobs.phenomTruncated, undefined);
});

test('without fetchResponse (no cookie) the alternating orderings leave rows unread: page_failed, not complete', async () => {
  const be = twoReplicaBackend(450);
  const { result: jobs, errors } = await quiet(() => phenom.fetch(ENTRY, { sleep: async () => {}, fetchJson: be.fetchJsonOnly }));
  assert.ok(jobs.length < 450, `expected a short read, got ${jobs.length}`);
  assert.equal(jobs.collection.status, 'page_failed');
  assert.ok(errors.some((e) => /ExampleCo/.test(e) && /of 450/.test(e)), JSON.stringify(errors));
});

test('a cookie a later response changes is sent with its new value', async () => {
  const seen = [];
  const pages = [
    response(body(ids(1, 100).map((id) => job(id)), 250), ['PLAY_SESSION=s1; Path=/', 'PHPPPE_ACT=a1; Path=/']),
    response(body(ids(101, 100).map((id) => job(id)), 250), ['PLAY_SESSION=s2; Path=/']),
    response(body(ids(201, 50).map((id) => job(id)), 250)),
  ];
  const jobs = await phenom.fetch(ENTRY, { sleep: async () => {}, fetchResponse: async (url, opts) => { seen.push(opts.headers?.cookie ?? null); return pages[seen.length - 1]; } });
  assert.deepEqual(seen, [null, 'PLAY_SESSION=s1; PHPPPE_ACT=a1', 'PLAY_SESSION=s2; PHPPPE_ACT=a1']);
  assert.equal(jobs.collection.status, 'complete');
  assert.equal(jobs.length, 250);
});

test('every request is a POST to the branded /widgets endpoint that refuses redirects', async () => {
  const seen = [];
  await phenom.fetch(ENTRY, { sleep: async () => {}, fetchResponse: async (url, opts) => { seen.push({ url, method: opts.method, redirect: opts.redirect }); return response(body([job(1)], 1)); } });
  assert.deepEqual(seen, [{ url: 'https://careers.exampleco.com/widgets', method: 'POST', redirect: 'error' }]);
});

// Page-sequence helper: each element is [jobs, totalHits]; served in order through fetchResponse.
function served(seq) {
  let i = 0;
  return { sleep: async () => {}, fetchResponse: async () => { const [jobs, total] = seq[i++] ?? [[], 0]; return response(body(jobs, total)); }, calls: () => i };
}

test('a page that reports another totalHits: unverified, and the walk reads on to the end', async () => {
  const ctx = served([[ids(1, 100).map((id) => job(id)), 250], [ids(101, 100).map((id) => job(id)), 260], [ids(201, 60).map((id) => job(id)), 260]]);
  const { result: jobs } = await quiet(() => phenom.fetch(ENTRY, ctx));
  assert.equal(jobs.length, 260);
  assert.equal(jobs.collection.status, 'unverified');
});

test('a row without a jobId: unverified even when the count is reached', async () => {
  const ctx = served([[[...ids(1, 99).map((id) => job(id)), job(null)], 101], [[job(100), job(101)], 101]]);
  const { result: jobs } = await quiet(() => phenom.fetch(ENTRY, ctx));
  assert.equal(jobs.collection.status, 'unverified');
});

test('a row with a jobId but no title is dropped by the parser: unverified, never complete', async () => {
  const ctx = served([[ids(1, 100).map((id) => job(id)), 150], [[...ids(101, 49).map((id) => job(id)), job(150, '   ')], 150]]);
  const { result: jobs, errors } = await quiet(() => phenom.fetch(ENTRY, ctx));
  assert.equal(jobs.length, 149);
  assert.equal(jobs.collection.status, 'unverified');
  assert.ok(errors.some((e) => /ExampleCo/.test(e) && /1 row/.test(e)), JSON.stringify(errors));
});

test('an empty page short of totalHits: page_failed', async () => {
  const ctx = served([[ids(1, 100).map((id) => job(id)), 300], [[], 300]]);
  const { result: jobs } = await quiet(() => phenom.fetch(ENTRY, ctx));
  assert.equal(jobs.length, 100);
  assert.equal(jobs.collection.status, 'page_failed');
  assert.ok(jobs.truncated && jobs.truncated.reason === 'source-reports-more' && jobs.truncated.total === 300);
});

test('an empty first page of a board that reports rows: page_failed (not an empty board)', async () => {
  const ctx = served([[[], 40]]);
  const { result: jobs } = await quiet(() => phenom.fetch(ENTRY, ctx));
  assert.equal(jobs.length, 0);
  assert.equal(jobs.collection.status, 'page_failed');
});

test('a board that reports no totalHits: read to an empty page, unverified', async () => {
  const ctx = served([[ids(1, 100).map((id) => job(id)), undefined], [ids(101, 30).map((id) => job(id)), undefined], [[], undefined]]);
  const { result: jobs } = await quiet(() => phenom.fetch(ENTRY, ctx));
  assert.equal(ctx.calls(), 3);
  assert.equal(jobs.length, 130);
  assert.equal(jobs.collection.status, 'unverified');
});

test('an empty board (totalHits 0): complete', async () => {
  const jobs = await phenom.fetch(ENTRY, served([[[], 0]]));
  assert.equal(jobs.length, 0);
  assert.equal(jobs.collection.status, 'complete');
});

test('a page of jobIds already read: page_failed, the walk stops there', async () => {
  const first = ids(1, 100).map((id) => job(id));
  const ctx = served([[first, 300], [first, 300], [ids(201, 100).map((id) => job(id)), 300]]);
  const { result: jobs } = await quiet(() => phenom.fetch(ENTRY, ctx));
  assert.equal(ctx.calls(), 2);
  assert.equal(jobs.length, 100);
  assert.equal(jobs.collection.status, 'page_failed');
});

test('the offsets run past totalHits short of it (repeats inside pages): page_failed', async () => {
  const ctx = served([[ids(1, 100).map((id) => job(id)), 200], [[...ids(51, 50), ...ids(101, 50)].map((id) => job(id)), 200]]);
  const { result: jobs } = await quiet(() => phenom.fetch(ENTRY, ctx));
  assert.equal(ctx.calls(), 2);
  assert.equal(jobs.length, 150);
  assert.equal(jobs.collection.status, 'page_failed');
});

test('max_pages runs out first: ceiling', async () => {
  let n = 0;
  const { result: jobs } = await quiet(() => phenom.fetch({ ...ENTRY, max_pages: 2 }, { sleep: async () => {}, fetchResponse: async () => { n++; return response(body(ids(n * 1000, 100).map((id) => job(id)), 5000)); } }));
  assert.equal(n, 2);
  assert.equal(jobs.length, 200);
  assert.equal(jobs.collection.status, 'ceiling');
  assert.equal(jobs.phenomTruncated, true);
});

test('ctx.maxPages (liveness probe) runs out first: ceiling', async () => {
  let n = 0;
  const { result: jobs } = await quiet(() => phenom.fetch(ENTRY, { maxPages: 1, sleep: async () => {}, fetchResponse: async () => { n++; return response(body(ids(1, 100).map((id) => job(id)), 5000)); } }));
  assert.equal(n, 1);
  assert.equal(jobs.collection.status, 'ceiling');
});

test('a later page whose request fails after retries: page_failed, the rows already read are kept', async () => {
  let n = 0;
  const { result: jobs } = await quiet(() => phenom.fetch(ENTRY, { sleep: async () => {}, fetchResponse: async () => {
    n++;
    if (n === 1) return response(body(ids(1, 100).map((id) => job(id)), 150));
    throw new Error('network blip');
  } }));
  assert.equal(jobs.length, 100);
  assert.equal(jobs.collection.status, 'page_failed');
  assert.equal(jobs.phenomTruncated, true);
});

test('a first page whose request fails still throws (the list fails, nothing advances)', async () => {
  await assert.rejects(quiet(() => phenom.fetch(ENTRY, { sleep: async () => {}, fetchResponse: async () => { const e = new Error('Bad Request'); e.status = 400; throw e; } })), /Bad Request/);
});

test('a first page that is not JSON throws', async () => {
  await assert.rejects(phenom.fetch(ENTRY, { sleep: async () => {}, fetchResponse: async () => ({ status: 200, headers: { getSetCookie: () => [] }, text: async () => '<html>blocked</html>' }) }));
});

test('an HTTP-200 page that is not JSON is retried with the same session, and the walk completes', async () => {
  const seen = [];
  let n = 0;
  const jobs = await phenom.fetch(ENTRY, { sleep: async () => {}, fetchResponse: async (url, opts) => {
    n++;
    seen.push({ from: JSON.parse(opts.body).from, cookie: opts.headers?.cookie ?? null });
    if (n === 1) return response(body(ids(1, 100).map((id) => job(id)), 150), ['PLAY_SESSION=sA; Path=/']);
    if (n === 2) return { status: 200, headers: { getSetCookie: () => [] }, text: async () => '<html>busy</html>' };
    return response(body(ids(101, 50).map((id) => job(id)), 150));
  } });
  assert.deepEqual(seen, [{ from: 0, cookie: null }, { from: 100, cookie: 'PLAY_SESSION=sA' }, { from: 100, cookie: 'PLAY_SESSION=sA' }]);
  assert.equal(jobs.length, 150);
  assert.equal(jobs.collection.status, 'complete');
});

test('a page of known jobIds that newly carries a title for one dropped earlier keeps it and reads on', async () => {
  const first = [...ids(1, 99).map((id) => job(id)), job(100, '')];
  const again = [...ids(1, 99).map((id) => job(id)), job(100)];
  const ctx = served([[first, 300], [again, 300], [ids(101, 100).map((id) => job(id)), 300]]);
  const { result: jobs } = await quiet(() => phenom.fetch(ENTRY, ctx));
  assert.equal(ctx.calls(), 3);
  assert.equal(jobs.length, 200);
  assert.ok(jobs.some((j) => /\/job\/100\//.test(j.url)));
  // 200 distinct jobIds of 300 when the offsets run out: short, so page_failed (jobId 100 no longer counts as dropped).
  assert.equal(jobs.collection.status, 'page_failed');
});
