/** Refuse stale dynamic claims before a candidate becomes live; KS-009, GN-001. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requirements, pinHash } from './requirements.ts';
import { Schemas } from '../schema/index.ts';
import type { Entry, Recorded } from './types.ts';
const hash = `sha256:${'a'.repeat(64)}`;
const changed = `sha256:${'b'.repeat(64)}`;
function entry(name: string): Entry {
  return { path: `/layout/${name}/index.ts`, state: '/state', settings: {}, manifest: { name, version: '1.0.0', settings: {}, requires: {}, provides: {}, envelope: { requires: ['service/dynamic'], provides: ['service/dynamic'], spawn: { scope: 'person', network: 'none' } } } };
}
await test('KS-009 unchanged immutable registrations satisfy concrete requirements independently of init order', async () => {
  const schemas = new Schemas(); await schemas.load(); const consumer = entry('consumer'); const producer = entry('producer');
  const registration = { requires: {}, provides: { 'service/dynamic': '1.0.0' } };
  const registrations: Recorded = [{ source: 'producer@1.0.0', hash, registration }];
  const pins = { producer: { hash, mount: '/packages/producer@1.0.0' }, consumer: { hash, mount: '/layout/consumer' } };
  const result = await requirements([consumer, producer], 'person', { registrations }, pins, consumer, { requires: { 'service/dynamic': '^1' }, provides: {} }, schemas);
  assert.ok(result.ok, JSON.stringify(result)); assert.equal(result.value.length, 2); assert.equal(pinHash(consumer, pins), hash);
  const stale = await requirements([consumer, producer], 'person', { registrations }, { ...pins, producer: { hash: changed, mount: '/packages/producer@1.0.0' } }, consumer, { requires: { 'service/dynamic': '^1' }, provides: {} }, schemas);
  assert.ok(!stale.ok); assert.equal(stale.error.code, 'gap');
});
await test('KS-009 recorded registration envelopes, collisions and inherited fact scopes remain authoritative', async () => {
  const schemas = new Schemas(); await schemas.load(); const consumer = entry('consumer'); const producer = entry('producer');
  const pins = { producer: { hash, mount: '/packages/producer@1.0.0' } };
  const actual = { requires: {}, provides: {} };
  const registration = { requires: {}, provides: { 'service/outside': '1.0.0' } };
  const record = { source: 'producer@1.0.0', hash, registration };
  const outside = await requirements([consumer, producer], 'person', { registrations: [record] }, pins, consumer, actual, schemas);
  assert.ok(!outside.ok); assert.equal(outside.error.code, 'envelope');
  const duplicate = await requirements([consumer, producer], 'person', { registrations: [{ ...record, registration: actual }, { ...record, registration: actual }] }, pins, consumer, actual, schemas);
  assert.ok(!duplicate.ok); assert.equal(duplicate.error.code, 'collision');
  const scope = await requirements([consumer], 'deployment', { provided: { 'service/dynamic': { version: '1.0.0', scope: 'person' } } }, {}, consumer, { requires: { 'service/dynamic': '^1' }, provides: {} }, schemas);
  assert.ok(!scope.ok); assert.equal(scope.error.code, 'scope');
});
await test('KS-009 the actual registration replaces an earlier captured provision during a private probe', async () => {
  const schemas = new Schemas(); await schemas.load(); const consumer = entry('consumer'); const producer = entry('producer');
  consumer.manifest.requires = { 'service/dynamic': '^1' };
  const registration = { requires: {}, provides: { 'service/dynamic': '1.0.0' } };
  const pins = { producer: { hash, mount: '/packages/producer@1.0.0' } };
  const result = await requirements([consumer, producer], 'person', { registrations: [{ source: 'producer@1.0.0', hash, registration }] }, pins, producer, { requires: {}, provides: {} }, schemas);
  assert.ok(!result.ok); assert.equal(result.error.code, 'gap');
});
