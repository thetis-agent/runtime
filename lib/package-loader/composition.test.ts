/** Keep replacement registrations from retaining removed capabilities; KS-009, ADR 0045. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { compose } from './composition.ts';
import { resolve } from '../semver-match/index.ts';
import type { Entry } from './types.ts';

await test('KS-009 fresh registration composition removes obsolete requirements and provisions without changing manifests', () => {
  const producer: Entry = { path: '/packages/producer/index.ts', state: '/state/producer', settings: {}, manifest: { name: 'producer', version: '1.0.0', settings: {},
    requires: {}, provides: { 'service/static': '1.0.0' }, envelope: { requires: [], provides: ['service/*'], spawn: { scope: 'person', network: 'none' } } } };
  const consumer: Entry = { ...producer, manifest: { ...producer.manifest, name: 'consumer', requires: { 'service/dynamic': '^1' }, provides: {} } };
  const entries = [consumer, producer]; const original = structuredClone(entries);
  const valid = compose(entries, 'person', [{ source: 'producer@1.0.0', registration: { requires: {}, provides: { 'service/dynamic': '1.0.0' } } }]);
  assert.ok(resolve(valid).ok);
  const removed = compose(entries, 'person', [{ source: 'producer@1.0.0', registration: { requires: {}, provides: {} } }]);
  const refusal = resolve(removed); assert.ok(!refusal.ok); assert.equal(refusal.error.code, 'gap');
  assert.deepEqual(entries, original);
});
