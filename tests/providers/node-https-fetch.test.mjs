import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { nodeHttpsFetch } from '../../providers/_node-https-fetch.mjs';
import { isRefusedRedirectError } from '../../providers/_http.mjs';
import workday from '../../providers/workday.mjs';

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('POST sends method, headers and body; returns status and JSON', async () => {
  const { server, base } = await serve((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ method: req.method, ua: req.headers['user-agent'], body: JSON.parse(b) }));
    });
  });
  try {
    const res = await nodeHttpsFetch(`${base}/x`, { method: 'POST', headers: new Headers({ 'user-agent': 'UA1', 'content-type': 'application/json' }), body: '{"a":1}' });
    assert.equal(res.status, 200);
    assert.equal(res.ok, true);
    assert.deepEqual(await res.json(), { method: 'POST', ua: 'UA1', body: { a: 1 } });
  } finally { server.close(); }
});

test('gzip and br bodies are decoded and content-encoding is dropped', async () => {
  const payload = JSON.stringify({ total: 3, jobPostings: [1, 2, 3] });
  for (const enc of ['gzip', 'br']) {
    const { server, base } = await serve((req, res) => {
      res.setHeader('content-encoding', enc);
      res.end(enc === 'gzip' ? zlib.gzipSync(payload) : zlib.brotliCompressSync(payload));
    });
    try {
      const res = await nodeHttpsFetch(base);
      assert.equal(res.headers.get('content-encoding'), null);
      assert.equal(await res.text(), payload);
    } finally { server.close(); }
  }
});

test('429 is returned as a non-ok Response with headers intact', async () => {
  const { server, base } = await serve((req, res) => {
    res.statusCode = 429;
    res.setHeader('retry-after', '30');
    res.setHeader('cf-mitigated', 'challenge');
    res.end('<html>challenge</html>');
  });
  try {
    const res = await nodeHttpsFetch(base);
    assert.equal(res.status, 429);
    assert.equal(res.ok, false);
    assert.equal(res.headers.get('retry-after'), '30');
    assert.equal(res.headers.get('cf-mitigated'), 'challenge');
    assert.match(await res.text(), /challenge/);
  } finally { server.close(); }
});

test("redirect:'error' on a 3xx rejects as a refused redirect; 'manual' returns it", async () => {
  const { server, base } = await serve((req, res) => { res.statusCode = 302; res.setHeader('location', '/elsewhere'); res.end(); });
  try {
    await assert.rejects(nodeHttpsFetch(base, { redirect: 'error' }), (err) => isRefusedRedirectError(err));
    const res = await nodeHttpsFetch(base, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/elsewhere');
  } finally { server.close(); }
});

test('abort rejects and a refused connection is a TypeError with a cause code', async () => {
  const { server, base } = await serve(() => { /* never answers */ });
  try {
    const ac = new AbortController();
    const p = nodeHttpsFetch(base, { signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    await assert.rejects(p, (err) => err?.name === 'AbortError');
  } finally { server.closeAllConnections?.(); server.close(); }
  const { server: s2, base: b2 } = await serve(() => {});
  s2.close();
  await new Promise((r) => s2.on('close', r));
  await assert.rejects(nodeHttpsFetch(b2), (err) => err instanceof TypeError && typeof err.cause?.code === 'string');
});

test('workday asks for the node:https transport on its CXS POST', async () => {
  const seen = [];
  const ctx = {
    transport: 'http',
    workdayGate: null,
    fetchJson: async (url, opts) => { seen.push(opts); return { total: 0, jobPostings: [] }; },
    fetchText: async (url, opts) => { seen.push(opts); return ''; },
  };
  try {
    await workday.fetch({ name: 'Acme', careers_url: 'https://acme.wd5.myworkdayjobs.com/External' }, ctx);
  } catch { /* an empty board may be reported as an error; only the transport flag matters */ }
  assert.ok(seen.length > 0, 'workday made no request');
  for (const opts of seen) assert.equal(opts.nodeHttps, true);
});

test('304 is returned as a Response (for acceptNotModified), not refused as a redirect', async () => {
  const { server, base } = await serve((req, res) => { res.statusCode = 304; res.setHeader('etag', '"v1"'); res.end(); });
  try {
    const res = await nodeHttpsFetch(base, { redirect: 'error' });
    assert.equal(res.status, 304);
    assert.equal(res.body, null);
  } finally { server.close(); }
});

test('a refused redirect closes the connection instead of draining its body', async () => {
  let closed;
  const done = new Promise((r) => { closed = r; });
  const { server, base } = await serve((req, res) => {
    res.writeHead(302, { location: '/x' });
    res.write('a'.repeat(1024));
    res.on('close', () => closed());
    // never ends: an endless redirect body
  });
  try {
    await assert.rejects(nodeHttpsFetch(base, { redirect: 'error' }), (err) => isRefusedRedirectError(err));
    await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('upstream not closed')), 2000))]);
  } finally { server.closeAllConnections?.(); server.close(); }
});

test('cancelling a decoded (gzip) body closes the upstream response', async () => {
  let closed;
  const done = new Promise((r) => { closed = r; });
  const { server, base } = await serve((req, res) => {
    res.writeHead(200, { 'content-encoding': 'gzip' });
    const gz = zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH });
    gz.pipe(res);
    const iv = setInterval(() => gz.write('x'.repeat(4096)), 5);
    res.on('close', () => { clearInterval(iv); closed(); });
  });
  try {
    const res = await nodeHttpsFetch(base);
    const reader = res.body.getReader();
    await reader.read();
    await reader.cancel();
    await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('upstream not closed')), 2000))]);
  } finally { server.closeAllConnections?.(); server.close(); }
});
