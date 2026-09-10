/** Defend caller identity and generation fencing even under deliberate delegation; ADR 0021. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Identity } from './index.ts';

function fixture(): Identity {
  return new Identity({ people: [
    { id: 'alice', role: 'user', projects: ['atlas'], observeOthers: false },
    { id: 'bob', role: 'reviewer', projects: [], observeOthers: true }
  ], bindings: [{ kind: 'password', id: 'external-alice', person: 'alice' }], authorities: { password: 'authority' } }, () => 0);
}

await test('KS-006 undesignated evidence cannot mint a principal', () => {
  const identity = fixture();
  assert.equal(identity.assert('other', 'password', 'external-alice').ok, false);
  assert.equal(identity.assert('authority', 'password', 'external-alice').ok, true);
});

await test('KS-007 unknown external bindings create no principal', () => {
  const identity = fixture();
  assert.deepEqual(identity.assert('authority', 'password', 'unknown'), { ok: false, error: { code: 'unbound', message: 'The password identity has no binding.' } });
  assert.equal(identity.principal('unknown'), undefined);
});

await test('ADR-0021 delegated credentials cannot cross people and expire at the same generation fence', () => {
  const identity = fixture();
  const issued = identity.issue({ id: 'run', person: 'alice', scope: 'person', target: 'alice', generation: 1, services: [] });
  assert.ok(issued.ok);
  const delegated = issued.value;
  assert.equal(identity.access(delegated, 'alice').ok, true);
  assert.equal(identity.access(delegated, 'bob').ok, false);
  assert.equal(identity.whois(delegated, delegated).ok, true);
  identity.fence('alice', 2);
  assert.deepEqual(identity.authenticate(delegated), { ok: false, error: { code: 'fenced', message: 'The run generation has been fenced.' } });
});

await test('Identity tokens expire and return bounded pool capacity', () => {
  let now = 0;
  const identity = new Identity({ people: [{ id: 'a', role: 'user', projects: [], observeOthers: false }], bindings: [], authorities: {}, tokens: 1, tokenLifetimeMs: 10 }, () => now);
  const run = { id: 'r', person: 'a', scope: 'person', target: 'a', generation: 1, services: [] } satisfies Parameters<Identity['issue']>[0];
  const issued = identity.issue(run);
  assert.ok(issued.ok);
  assert.equal(identity.issue(run).ok, false);
  now = 10;
  assert.equal(identity.authenticate(issued.value).ok, false);
  assert.equal(identity.issue(run).ok, true);
});
