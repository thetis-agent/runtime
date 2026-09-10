/** Ensure history projection cannot mutate an observed snapshot before journal commit; implementation note 0033, GN-005. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { project } from './projection.ts';
import type { View } from './projection.ts';
await test('GN-005 projection preserves prior snapshot bytes while replacing candidate and rollback epochs', () => {
  const view: View = { state: 'PROBING', current: { n: 2, pins: { package: 'old' }, stateSnapshot: 'saved', prefixRenderer: 'old', at: 1 }, candidate: { n: 3, pins: { package: 'new' }, stateSnapshot: 'saved', prefixRenderer: 'new', at: 2 }, since: 2 };
  const original = JSON.stringify(view); const healthy = project(view, 'SWITCHING', { event: 'healthy' }, 3);
  assert.equal(JSON.stringify(view), original); assert.equal(healthy.committed, true);
  healthy.current.pins['package'] = 'independent'; assert.equal(view.current.pins['package'], 'old');
  const restored = project(healthy, 'LIVE', { event: 'restored' }, 4);
  assert.equal(restored.current.n, 4); assert.equal(restored.candidate, undefined); assert.equal(restored.committed, undefined);
});

await test('implementation note 0043 the healthy candidate retains its migrated snapshot without replacing the undo snapshot', () => {
  const current = { n: 1, pins: { package: 'old' }, stateSnapshot: 'before-migration', prefixRenderer: '1', at: 0 };
  const view: View = { state: 'PROBING', current, candidate: { ...current, n: 2, pins: { package: 'new' } }, since: 0 };
  const healthy = project(view, 'SWITCHING', { event: 'healthy', snapshot: 'after-migration' }, 1);
  const committed = project(healthy, 'LIVE', { event: 'repointed', stop: true }, 2);
  assert.equal(committed.current.stateSnapshot, 'after-migration');
  assert.equal(committed.previous?.stateSnapshot, 'before-migration');
  assert.equal(view.candidate?.stateSnapshot, 'before-migration');
});
