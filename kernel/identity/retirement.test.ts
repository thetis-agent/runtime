/** Reclaim ephemeral identities without weakening persistent generation fences; KS-008, ADR 0046. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Identity } from './index.ts';

await test('KS-008 retiring ephemeral targets reclaims capacity and revokes serving and provisional credentials', () => {
  const identity = new Identity({ people: [], bindings: [], authorities: {}, tokens: 3 }, () => 0);
  const run = { id: 'run', person: '', scope: 'deployment' as const, target: 'persistent', generation: 1, services: [] };
  const persistent = identity.issue(run); assert.ok(persistent.ok); identity.fence(run.target, 2); identity.revoke(persistent.value);
  for (let n = 0; n < 8; n++) {
    const target = `transient-${String(n)}`;
    const serving = identity.issue({ ...run, target }); assert.ok(serving.ok);
    const probe = identity.stage({ ...run, target, generation: 2 }); assert.ok(probe.ok);
    identity.retire(target);
    assert.equal(identity.authenticate(serving.value).ok, false);
    assert.equal(identity.authenticate(probe.value, 'probe').ok, false);
  }
  const stale = identity.issue(run); assert.ok(!stale.ok); assert.equal(stale.error.code, 'fenced');
  assert.ok(identity.issue({ ...run, generation: 2 }).ok);
});
