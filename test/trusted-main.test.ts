/** Exercise evidence submission, secret entry and the final act through the shipped kernel; KS-014–016. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { kernelProcess } from './kernel-process.ts';
import { post } from './origin-http.ts';
import { isObject } from '../lib/schema/index.ts';
import { trustedFixture, authority } from './trusted-fixture.ts';

await test('KS-015 the actual kernel consumes its master-key descriptor and completes a cookie-authenticated default act', async () => {
  const fixture = await trustedFixture(); const { root, path, origin, digest, material } = fixture;
  let kernel = await kernelProcess(path);
  try {
    const endpoint = fixture.endpoint();
    const submitted = await authority(endpoint, 'results.submit', material.submission); assert.equal(submitted['ok'], true, JSON.stringify(submitted));
    const identity = await authority(endpoint, 'identity.assert', { kind: 'password', id: 'external-reviewer', evidence: {} }); assert.equal(identity['ok'], true); assert.ok(isObject(identity['value']));
    const login = await post(origin, '/session', { sessionToken: identity['value']['sessionToken'] }); assert.equal(login.status, 200); const cookie = login.cookies[0]?.split(';')[0]; assert.ok(cookie);
    const prepared = await post(origin, '/default.prepare', { digest, baseline: 1 }, undefined, cookie); assert.equal(prepared.status, 200, prepared.text); const code = prepared.text.trim().split(' ').at(-1); assert.ok(code);
    assert.equal((await post(origin, '/secret.set', { scope: 'deployment', name: 'provider-key', value: 'never-log-this-secret' }, undefined, cookie)).status, 200);
    const committed = await post(origin, '/default.set', { digest, baseline: 1, code }, undefined, cookie); assert.equal(committed.status, 200, committed.text);
    const rows = await readFile(join(root, 'observed.jsonl'), 'utf8'); assert.ok(rows.includes('default.set')); assert.ok(!rows.includes('never-log-this-secret')); assert.ok(!kernel.errors().includes('never-log-this-secret'));
    await kernel.close(); kernel = await kernelProcess(path);
    const identityAgain = await authority(endpoint, 'identity.assert', { kind: 'password', id: 'external-reviewer', evidence: {} }); assert.ok(isObject(identityAgain['value']));
    const loggedIn = await post(origin, '/session', { sessionToken: identityAgain['value']['sessionToken'] }); const restoredCookie = loggedIn.cookies[0]?.split(';')[0]; assert.ok(restoredCookie);
    const stale = await post(origin, '/default.prepare', { digest, baseline: 1 }, undefined, restoredCookie); assert.equal(stale.status, 400); assert.ok(stale.text.includes('baseline-moved'));
    const restoredRows = await readFile(join(root, 'observed.jsonl'), 'utf8'); assert.equal(restoredRows.split('\n').filter(row => row.includes('"target":"default"') && row.includes('"kind":"generation.initial"')).length, 1);
    const current: unknown = JSON.parse(await readFile(join(root, 'default/current.json'), 'utf8')); assert.ok(isObject(current)); assert.equal(current['baseline'], 3);
  } finally { await kernel.close(); await rm(root, { recursive: true, force: true }); }
});
