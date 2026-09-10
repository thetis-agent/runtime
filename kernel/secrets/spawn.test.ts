/** Report unmet declared secret requirements without selecting another scope; ADR 0009, KS-008. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { Secrets } from '@/kernel/secrets/index.ts';
import { deliver, declaration } from '@/kernel/secrets/spawn.ts';
import type { Spawn, Entry } from '@/lib/package-loader/types.ts';
import { Schemas } from '@/lib/schema/index.ts';

await test('KS-008 spawn secret gaps use the exact requirement sentence and never fall through scopes', async () => {
  const root = await mkdtemp('/tmp/spawn-secret-');
  const pkg = { name: 'adapter', version: '1.0.0', requires: { 'secret/key': '^1' } };
  const spawn: Spawn = { id: 'adapter', scope: 'person', cmd: 'node', args: [], env: { KEY: 'secret/key' }, health: { rpc: 'health.probe' }, restart: 'never', network: 'none' };
  const expected = { ok: false, error: { code: 'gap', message: 'adapter 1.0.0 requires secret/key ^1. Nothing in this profile provides it. No configured registry provides it.' } };
  try {
    assert.deepEqual(await deliver(undefined, 'run', 'person/alice', spawn, pkg), expected);
    const store = await Secrets.open(root, new Uint8Array(32)); assert.ok(store.ok);
    assert.ok((await store.value.set({ id: 'admin', role: 'admin', projects: [], observeOthers: false }, 'kernel', { scope: 'deployment', name: 'key', value: 'deployment-only' })).ok);
    assert.deepEqual(await deliver(store.value, 'run', 'person/alice', spawn, pkg), expected);
    assert.deepEqual(await deliver(store.value, 'run', 'deployment', spawn, pkg), { ok: true, value: { KEY: 'deployment-only' } });
    assert.equal((await store.value.deliver('run', 'key')).ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('KS-009 a static spawn does not repeat manifest requirements as dynamic envelope additions', async () => {
  const schemas = new Schemas(); await schemas.load();
  const spawn: Spawn = { id: 'adapter', scope: 'deployment', cmd: 'node', args: ['/adapter/service.ts'], env: { KEY: 'secret/key' }, health: { rpc: 'health.probe' }, restart: 'never', network: 'none' };
  const entry: Entry = { path: '/adapter/index.ts', state: '/state', settings: {}, manifest: { name: 'adapter', version: '1.0.0', requires: { 'secret/key': '*', 'contract/provider': '^1' }, provides: {}, settings: {}, envelope: { requires: [], provides: [], spawn: { scope: 'deployment', network: 'none' } } } };
  assert.deepEqual(await declaration(entry, { id: 'adapter', declared: spawn }, schemas), { ok: true, value: spawn });
  assert.equal((await declaration(entry, { id: 'adapter', declared: spawn, requires: { 'cap/extra': '*' } }, schemas)).ok, false);
  assert.equal((await declaration(entry, { id: 'adapter', declared: { ...spawn, env: { KEY: 'secret/other' } } }, schemas)).ok, false);
});
