// browser-only: the provider never requests anything and always fails the list
// with a message that names the careers host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import provider, { resolveCareersUrl } from '../../providers/browser-only.mjs';

test('id and detect', () => {
  assert.equal(provider.id, 'browser-only');
  assert.equal(provider.detect({ careers_url: 'https://www.tesla.com/careers/search/' }), null);
});

test('fetch never calls the transport and fails with a browser-read message', async () => {
  let calls = 0;
  const ctx = { fetchText: async () => { calls++; return ''; }, fetchJson: async () => { calls++; return {}; }, sleep: async () => {} };
  await assert.rejects(
    () => provider.fetch({ name: 'Tesla', careers_url: 'https://www.tesla.com/careers/search/?type=intern&site=US' }, ctx),
    /browser-only: Tesla: www\.tesla\.com blocks scripted requests \(bot challenge\) — needs a browser read/,
  );
  assert.equal(calls, 0);
});

test('a careers_url that is missing, not HTTPS or carries credentials is refused', async () => {
  for (const careers_url of [undefined, 'not a url', 'http://www.tesla.com/careers', 'https://user:pw@www.tesla.com/careers']) {
    assert.throws(() => resolveCareersUrl({ name: 'X', careers_url }), /browser-only: X: careers_url must/);
    await assert.rejects(() => provider.fetch({ name: 'X', careers_url }, {}), /careers_url must/);
  }
});
