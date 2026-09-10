/** Keep a real installed release while its live conversation retains the pin; KS-011. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeFixture, people } from './runtime-fixture.ts';
import { registryService } from './registry-service.ts';
import { call } from '../lib/registry/client.ts';
import { Pins } from '../lib/pins/index.ts';
import { isObject } from '../lib/schema/index.ts';
import schema from '../contracts/registry/schema.json' with { type: 'json' };
import type { Pin } from '../contracts/registry/types.ts';

await test('KS-011 a hash-verified installed release cannot be pruned while named by a live conversation, including ledger recovery', async () => {
  const registry = await registryService(); const f = await runtimeFixture();
  try {
    assert.ok((await registry.process.probe()).ok); const socket = join(registry.root, 'endpoint/service.sock');
    const published = await call(socket, { v: '1', id: 'publish', method: 'publish', source: '/sources/sample', note: '', at: 0 }, registry.schemas);
    assert.ok(published.ok); assert.ok(registry.schemas.compile<Pin>({ ...schema, $id: 'thetis://test/live-pin', $ref: '#/$defs/pin' })(published.value));
    const pin = published.value;
    const fetched = await call(socket, { v: '1', id: 'install', method: 'fetch', pin }, registry.schemas); assert.ok(fetched.ok);
    const person = people[0]; assert.ok(person); const target = await f.environment(person.id);
    target.revision = { ...target.revision, pins: { ...target.revision.pins, sample: { source: join(registry.root, 'cache', pin.commit), hash: pin.hash, mount: '/sample' } } };
    assert.ok((await f.runtime.start(target)).ok);
    const conversation = await f.runtime.session(person, 'session.create', { surface: 'headless' }); assert.ok(conversation.ok && isObject(conversation.value));
    const id = conversation.value['id']; assert.equal(typeof id, 'string');
    const prune = () => call(socket, { v: '1', id: 'prune', method: 'prune', pin }, registry.schemas);
    const denied = await f.runtime.prune(pin.hash, prune); assert.ok(!denied.ok); assert.equal(denied.error.code, 'conflict');
    assert.equal(denied.error.message, `The release is pinned by live conversation ${String(id)}.`);
    const recovered = new Pins(join(f.root, 'targets/conversation-pins.json'), f.schemas);
    assert.deepEqual(await recovered.prune(pin.hash, prune), denied);
    const present = await call(socket, { v: '1', id: 'inspect', method: 'inspect', name: pin.name, version: pin.version }, registry.schemas); assert.ok(present.ok);
    assert.match(await readFile(join(registry.root, 'cache', pin.commit, 'package.json'), 'utf8'), /sample/u);
  } finally { await f.close(); await registry.close(); }
});
