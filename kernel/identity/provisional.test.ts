/** Keep private probes possible without admitting candidate calls before a switch; GN-003–004. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Identity } from './index.ts';

function fixture() {
  const identity = new Identity({ people: [{ id: 'alice', role: 'user', projects: [], observeOthers: false }], authorities: {}, bindings: [] }, () => 0);
  const run = { id: 'old', person: 'alice', scope: 'person' as const, target: 'alice', generation: 1, services: [] };
  const old = identity.issue(run); assert.ok(old.ok); return { identity, run, old: old.value };
}

await test('GN-004 provisional credentials cannot authorize calls until the atomic switch fences the old generation', () => {
  const f = fixture(); const candidate = f.identity.stage({ ...f.run, id: 'new', generation: 2 }); assert.ok(candidate.ok);
  assert.ok(f.identity.authenticate(candidate.value, 'probe').ok); assert.ok(!f.identity.authenticate(candidate.value).ok);
  assert.ok(f.identity.authenticate(f.old).ok); f.identity.fence('alice', 2);
  assert.ok(f.identity.authenticate(candidate.value).ok); const old = f.identity.authenticate(f.old); assert.ok(!old.ok); assert.equal(old.error.code, 'fenced');
  assert.ok(!f.identity.authenticate(f.old, 'probe').ok);
});

await test('GN-003 an abandoned candidate token never revives when its generation number is retried', () => {
  const f = fixture(); const first = f.identity.stage({ ...f.run, id: 'failed', generation: 2 }); assert.ok(first.ok);
  assert.ok(!f.identity.stage({ ...f.run, id: 'concurrent', generation: 2 }).ok);
  f.identity.revoke(first.value); const next = f.identity.stage({ ...f.run, id: 'retry', generation: 2 }); assert.ok(next.ok);
  f.identity.fence('alice', 2); assert.ok(f.identity.authenticate(next.value).ok); assert.ok(!f.identity.authenticate(first.value, 'probe').ok);
});
