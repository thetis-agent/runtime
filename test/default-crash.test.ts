/** Recover a half-committed default from all frozen member checkpoints after a real kernel kill; GN-005, ADR 0030. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watch } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { trustedFixture, authority } from '@/test/trusted-fixture.ts';
import { kernelProcess } from '@/test/kernel-process.ts';
import { post } from '@/test/origin-http.ts';
import { isObject } from '@/lib/schema/index.ts';
await test('GN-005 killed halfway through default promotion restores every frozen member before admission', async () => {
  const fixture = await trustedFixture(true); let kernel = await kernelProcess(fixture.path); let crashed = false;
  const promoting = Promise.withResolvers<undefined>(); const watcher = watch(fixture.work, (_event, name) => { if (name === 'promoting') promoting.resolve(undefined); });
  try {
    assert.equal((await authority(fixture.endpoint(), 'results.submit', fixture.material.submission))['ok'], true);
    const identity = await authority(fixture.endpoint(), 'identity.assert', { kind: 'password', id: 'external-reviewer', evidence: {} }); assert.ok(isObject(identity['value']));
    const login = await post(fixture.origin, '/session', { sessionToken: identity['value']['sessionToken'] }); const cookie = login.cookies[0]?.split(';')[0]; assert.ok(cookie);
    const prepared = await post(fixture.origin, '/default.prepare', { digest: fixture.digest, baseline: 1 }, undefined, cookie); const code = prepared.text.trim().split(' ').at(-1); assert.ok(code);
    const pending = post(fixture.origin, '/default.set', { digest: fixture.digest, baseline: 1, code }, undefined, cookie).then(() => false, () => true);
    await promoting.promise; watcher.close(); await kernel.crash(); crashed = true; assert.ok(await pending);
    kernel = await kernelProcess(fixture.path); crashed = false;
    for (const id of ['authority', 'secondary']) {
      const answered = await authority(fixture.endpoint(id), 'identity.assert', { kind: 'password', id: 'external-reviewer', evidence: {} }); assert.equal(answered['ok'], id === 'authority');
    }
    const current: unknown = JSON.parse(await readFile(join(fixture.root, 'default/current.json'), 'utf8')); assert.ok(isObject(current)); assert.equal(current['baseline'], 3); assert.notEqual(current['digest'], fixture.digest);
    const rows = await readFile(join(fixture.root, 'observed.jsonl'), 'utf8'); assert.ok(rows.includes('recovering the observed default')); assert.ok(rows.includes('all recovered deployment members probed'));
  } finally { watcher.close(); if (!crashed) await kernel.close(); await rm(fixture.root, { recursive: true, force: true }); }
});
