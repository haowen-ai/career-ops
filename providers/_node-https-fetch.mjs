// A minimal fetch() over node:https, for hosts whose CDN challenges undici.
//
// Workday's CXS API sits behind Cloudflare. Since 2026-11-15 every request sent
// by undici (global fetch, undici.fetch and undici.request, with or without
// HTTP/2) gets `429` + `cf-mitigated: challenge` from the very first request,
// while the SAME method, headers and body sent through node:https or curl get
// 200 JSON. Rate was not the cause: a 120/min pace still met the challenge on
// every tenant. So Workday requests go through this transport instead.
//
// It returns a WHATWG Response so fetchInContext's error, size-cap and body
// handling stay the one shared path. It runs inside the same provider-fetch
// async context, so the patched dns.lookup (_ip-guard.mjs) still validates the
// address node:https resolves.

import https from 'node:https';
import http from 'node:http';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

const REDIRECT_REFUSAL_CAUSE_MESSAGE = 'unexpected redirect';
const REDIRECT_STATUSES = new Set([300, 301, 302, 303, 307, 308]);

function decoderFor(encoding) {
  switch (String(encoding || '').trim().toLowerCase()) {
    case 'gzip': case 'x-gzip': return zlib.createGunzip();
    case 'deflate': return zlib.createInflate();
    case 'br': return zlib.createBrotliDecompress();
    default: return null;
  }
}

/**
 * fetch(url, init) over node:http(s). Supports method, headers (Headers or
 * object), string/Buffer body, redirect ('error' | 'manual'; 'follow' is
 * treated as 'manual' — provider fetches never follow), and signal.
 *
 * @param {string|URL} url
 * @param {{ method?: string, headers?: any, body?: any, redirect?: string, signal?: AbortSignal }} [init]
 * @returns {Promise<Response>}
 */
export function nodeHttpsFetch(url, init = {}) {
  const target = new URL(String(url));
  const lib = target.protocol === 'http:' ? http : https;
  const headers = {};
  for (const [k, v] of new Headers(init.headers ?? {})) headers[k] = v;
  const body = init.body == null ? null : (typeof init.body === 'string' || Buffer.isBuffer(init.body) ? init.body : String(init.body));
  if (body != null && headers['content-length'] === undefined) headers['content-length'] = String(Buffer.byteLength(body));
  const signal = init.signal;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError')); return; }
    const req = lib.request(target, { method: init.method || 'GET', headers, signal }, (res) => {
      const status = res.statusCode ?? 0;
      if (REDIRECT_STATUSES.has(status) && init.redirect === 'error') {
        // Close the connection instead of draining: a stalled or endless
        // redirect body must not keep downloading after the caller's timer
        // is cleared. 304 is not a redirect: it reaches acceptNotModified.
        res.destroy();
        req.destroy();
        reject(new TypeError('fetch failed', { cause: new Error(REDIRECT_REFUSAL_CAUSE_MESSAGE) }));
        return;
      }
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) for (const item of v) resHeaders.append(k, item);
        else if (v !== undefined) resHeaders.set(k, String(v));
      }
      const nullBody = status === 204 || status === 304 || (init.method || 'GET').toUpperCase() === 'HEAD';
      let stream = res;
      const decoder = nullBody ? null : decoderFor(res.headers['content-encoding']);
      if (decoder) {
        res.on('error', (err) => decoder.destroy(err));
        // A cancelled or failed decoded body (size cap, error-body cap, abort)
        // destroys the decoder; close the upstream response with it so the
        // socket does not stay open after the caller has given up.
        decoder.on('close', () => { if (!res.complete) res.destroy(); });
        decoder.on('error', () => { res.destroy(); });
        stream = res.pipe(decoder);
        // The decoded length differs from the wire length: drop the headers
        // that describe the encoded body, as fetch does.
        resHeaders.delete('content-encoding');
        resHeaders.delete('content-length');
      }
      if (nullBody) res.resume();
      try {
        resolve(new Response(nullBody ? null : Readable.toWeb(stream), {
          status,
          statusText: res.statusMessage || '',
          headers: resHeaders,
        }));
      } catch (err) {
        res.destroy();
        reject(err);
      }
    });
    req.on('error', (err) => {
      // Match fetch's shape: a transport failure is a TypeError whose cause is
      // the socket/DNS error (fetchInContext inspects err.cause.code), and an
      // abort rejects with the signal's reason.
      if (signal?.aborted) { reject(signal.reason ?? err); return; }
      reject(new TypeError('fetch failed', { cause: err }));
    });
    if (body != null) req.write(body);
    req.end();
  });
}
