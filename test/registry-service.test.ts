/** Verify service authority, immutable delivery and drain through real inherited descriptors; ADR 0007, KS-010. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { registryService } from '@/test/registry-service.ts';
import { call } from '@/lib/registry/client.ts';
import { isObject } from '@/lib/schema/index.ts';
import { snapshot } from '@/lib/snapshots/index.ts';
import type { Pin } from '@/lib/registry/types.ts';

await test('GN-002 registered registry serves hash-verified packages through its private socket', async () => {
  const fixture = await registryService();
  try {
    assert.ok((await fixture.process.probe()).ok);
    const socket = join(fixture.root, 'endpoint/service.sock');
    const published = await call(socket, { v: '1', id: 'publish', method: 'publish', source: '/sources/sample', note: '', at: 0 }, fixture.schemas);
    assert.ok(published.ok); assert.ok(isObject(published.value));
    const raw: unknown = JSON.parse(await readFile(new URL('../contracts/registry/schema.json', import.meta.url), 'utf8')); assert.ok(isObject(raw));
    const pin = fixture.schemas.compile<Pin>({ ...raw, $id: 'thetis://test/registry/pin', $ref: '#/$defs/pin' }); assert.ok(pin(published.value));
    const delivered = await call(socket, { v: '1', id: 'fetch', method: 'fetch', pin: published.value }, fixture.schemas); assert.ok(delivered.ok);
    assert.deepEqual(delivered.value, { pin: published.value, path: `/cache/${published.value.commit}` });
    assert.deepEqual(await snapshot(join(fixture.root, 'cache', published.value.commit)), { ok: true, value: published.value.hash });
    const refused = await call(socket, { v: '1', id: 'escape', method: 'publish', source: '/etc', note: '', at: 0 }, fixture.schemas); assert.equal(refused.ok, false);
    const wrong = await call(socket, { v: '1', id: 'wrong-prune', method: 'prune', pin: { ...published.value, hash: `sha256:${'0'.repeat(64)}` } }, fixture.schemas); assert.ok(!wrong.ok && wrong.error.code === 'hash-mismatch');
    const pruned = await call(socket, { v: '1', id: 'prune', method: 'prune', pin: published.value }, fixture.schemas); assert.deepEqual(pruned, { ok: true, value: { pruned: published.value.hash } });
    const removed = await call(socket, { v: '1', id: 'removed', method: 'fetch', pin: published.value }, fixture.schemas); assert.ok(!removed.ok && removed.error.code === 'not-found');
    const reused = await call(socket, { v: '1', id: 'reuse', method: 'publish', source: '/sources/sample', note: '', at: 0 }, fixture.schemas); assert.ok(!reused.ok && reused.error.code === 'conflict');
    assert.ok((await fixture.process.control.notify({ note: 'run.stop', params: {} })).ok);
    const health = await fixture.process.control.call('health.probe', {}); assert.ok(health.ok); assert.ok(isObject(health.value)); assert.equal(health.value['draining'], true);
    assert.ok((await fixture.process.control.notify({ note: 'env.updated', params: { resume: true } })).ok); assert.ok((await fixture.process.probe()).ok);
  } finally { await fixture.close(); }
});
