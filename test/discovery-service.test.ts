/** Capture static spawns deterministically through actual sandboxed package initialization; TE-021, KS-009. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { discoveryService } from './discovery-service.ts';
import { describe } from '../lib/package-loader/discovery-client.ts';
await test('TE-021 registered discovery captures exported spawns twice without starting them', async () => {
  const fixture = await discoveryService();
  try {
    assert.ok((await fixture.process.probe()).ok);
    const path = join(fixture.root, 'endpoint/service.sock');
    const first = await describe(path, fixture.schemas); const second = await describe(path, fixture.schemas);
    assert.ok(first.ok, JSON.stringify(first)); assert.deepEqual(first, second);
    assert.deepEqual(first.value.sources, ['provider-mock@1.0.0']); assert.deepEqual(first.value.failures, []);
    const spawn = first.value.registrations[0]?.registration.spawn?.[0]; assert.ok(spawn); assert.equal(spawn.id, 'provider'); assert.equal(spawn.scope, 'deployment'); assert.equal(spawn.cmd, 'node');
    assert.ok(spawn.args?.[0]?.endsWith('/packages/provider-mock/service.ts'));
    assert.deepEqual(await readdir(join(fixture.root, 'state')), ['.node-compile-cache']);
  } finally { await fixture.close(); }
});

await test('TE-021 every shipped package initializes in two fresh workers with identical registrations', async () => {
  const fixture = await discoveryService(true);
  try {
    assert.ok((await fixture.process.probe()).ok);
    const path = join(fixture.root, 'endpoint/service.sock');
    const first = await describe(path, fixture.schemas); const second = await describe(path, fixture.schemas);
    assert.ok(first.ok, JSON.stringify(first)); assert.deepEqual(first, second);
    assert.deepEqual(first.value.sources, fixture.sources); assert.deepEqual(first.value.failures, []);
    assert.ok(fixture.sources.length >= 11); assert.deepEqual(await readdir(join(fixture.root, 'state')), ['.node-compile-cache']);
  } finally { await fixture.close(); }
});
