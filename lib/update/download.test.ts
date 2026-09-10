/** Exercise only the external HTTP edge while keeping bounded streaming and transport checks real; ADR 0048, GN-002. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { download, fetched, downloadLimits } from './download.ts';

await test('release downloads stream exact bytes and reject excess before writing that chunk', async context => {
  const root = await mkdtemp('/tmp/download-');
  context.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response('signed asset')));
  try {
    const accepted = await download('https://release.test/asset', join(root, 'accepted'), 12);
    assert.deepEqual(accepted, { ok: true, value: 12 });
    assert.equal(await readFile(join(root, 'accepted'), 'utf8'), 'signed asset');
    const refused = await download('https://release.test/asset', join(root, 'refused'), 11);
    assert.equal(refused.ok, false); assert.equal(refused.error.code, 'budget');
    assert.equal((await readFile(join(root, 'refused'))).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('release downloads refuse an HTTPS downgrade before contacting its destination', async context => {
  let calls = 0;
  context.mock.method(globalThis, 'fetch', () => { calls++; return Promise.resolve(new Response(null, { status: 302, headers: { location: 'http://release.test/plaintext' } })); });
  const result = await fetched('https://release.test/asset', 1024);
  assert.equal(result.ok, false); assert.equal(result.error.code, 'invalid-args'); assert.equal(calls, 1);
});

await test('release downloads bound redirects and refuse credentials, unavailable assets and broken transport', async context => {
  let calls = 0;
  const remote = context.mock.method(globalThis, 'fetch', () => { calls++; return Promise.resolve(new Response(null, { status: 307, headers: { location: '/again' } })); });
  const loop = await fetched('https://release.test/asset', 1024);
  assert.equal(loop.ok, false); assert.equal(loop.error.code, 'budget'); assert.equal(calls, downloadLimits.redirects + 1);
  const credential = await fetched('https://user:password@release.test/asset', 1024);
  assert.equal(credential.ok, false); assert.equal(credential.error.code, 'invalid-args'); assert.equal(calls, downloadLimits.redirects + 1);
  remote.mock.mockImplementation(() => Promise.resolve(new Response(null, { status: 404 })));
  const missing = await fetched('https://release.test/asset', 1024); assert.equal(missing.ok, false); assert.equal(missing.error.code, 'io');
  remote.mock.mockImplementation(() => Promise.reject(new Error('external transport failure')));
  const broken = await fetched('https://release.test/asset', 1024); assert.equal(broken.ok, false); assert.equal(broken.error.code, 'io');
});
