/** Reject static and dynamic declarations through the real schema and matcher; KS-009, TE-021. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Register } from './registration.ts';
import { validator } from './index.ts';
import { Schemas } from '@/lib/schema/index.ts';
import type { Entry, Registration } from './types.ts';

const spawn = { id: 'service', cmd: 'node', args: ['entry.ts'], health: { rpc: 'health.probe' }, restart: 'on-failure', scope: 'deployment', network: 'none' };
const entry: Entry = { path: '/packages/fixture/index.ts', state: '/state', settings: {}, manifest: {
  name: 'fixture', version: '1.0.0', settings: {}, requires: { 'secret/static': '*' }, provides: {},
  envelope: { requires: ['secret/dynamic'], provides: ['service/dynamic'], spawn: { scope: 'deployment', network: 'none' } }
} };

async function register() {
  const schemas = new Schemas(); await schemas.load();
  return new Register(entry, await validator<Registration>(schemas, 'registration'));
}

await test('TE-021 static and initialized spawns combine deterministically inside the same envelope', async () => {
  const values: unknown[] = [];
  for (let run = 0; run < 2; run++) {
    const instance = await register();
    assert.ok(instance.register({ requires: { 'secret/dynamic': '*' }, provides: { 'service/dynamic': '1.0.0' }, spawn: [{ ...spawn, id: 'dynamic', env: { KEY: 'secret/dynamic' } }] }).ok);
    const result = instance.finish([{ ...spawn, env: { KEY: 'secret/static' }, extension: 'preserved' }]);
    assert.ok(result.ok); assert.equal(result.value?.spawn?.length, 2); assert.equal(result.value.spawn[0]?.['extension'], 'preserved'); values.push(result.value);
  }
  assert.deepEqual(values[0], values[1]);
});

await test('KS-009 static spawn shape, ids, scope, network and secret grants are bounded before activation', async () => {
  const cases: [unknown, string][] = [
    [{}, 'invalid-args'], [[{}], 'invalid-args'], [[spawn, spawn], 'invalid-args'],
    [[{ ...spawn, scope: 'person' }], 'envelope'], [[{ ...spawn, network: 'egress' }], 'envelope'],
    [[{ ...spawn, env: { KEY: 'secret/undeclared' } }], 'envelope'],
    [Array.from({ length: 33 }, (_, id) => ({ ...spawn, id: `s${String(id)}` })), 'invalid-args']
  ];
  for (const [value, code] of cases) {
    const instance = await register(); const result = instance.finish(value);
    assert.ok(!result.ok); assert.equal(result.error.code, code);
  }
  const instance = await register(); assert.ok(instance.register({ requires: {}, provides: {}, spawn: [spawn] }).ok);
  const result = instance.finish([spawn]); assert.ok(!result.ok); assert.equal(result.error.code, 'invalid-args');
});

await test('KS-009 an invalid or repeated initialized registration cannot be rescued by a static export', async () => {
  for (const value of [{ requires: { 'secret/other': '*' }, provides: {} }, { requires: {}, provides: { 'service/other': '*' } }, null]) {
    const instance = await register(); assert.ok(!instance.register(value).ok); assert.ok(!instance.finish([spawn]).ok);
  }
  const instance = await register(); assert.ok(instance.register({ requires: {}, provides: {} }).ok);
  assert.ok(!instance.register({ requires: {}, provides: {} }).ok); assert.ok(!instance.finish([spawn]).ok);
});
