/** Keep deployment identities personless and personal services inside one logical run; KS-022, ADR 0019. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Identity } from './index.ts';

await test('KS-022 deployment scope needs no person and cannot access a conversation as one', () => {
  const identity = new Identity({ people: [], bindings: [], authorities: {} }, () => 0);
  const service = identity.issue({ id: 'shared', person: '', scope: 'deployment', target: 'shared', generation: 1, services: [] }); assert.ok(service.ok);
  const resolved = identity.authenticate(service.value); assert.ok(resolved.ok); assert.equal(resolved.value.person, '');
  const access = identity.access(service.value, ''); assert.ok(!access.ok); assert.equal(access.error.code, 'forbidden');
  const invalid = identity.issue({ id: 'person', person: '', scope: 'person', target: 'person', generation: 1, services: [] }); assert.ok(!invalid.ok); assert.equal(invalid.error.code, 'unbound');
});

await test('KS-022 a personal service resolves only credentials of its own logical run', () => {
  const identity = new Identity({ people: [{ id: 'alice', role: 'user', projects: [], observeOthers: false }], bindings: [], authorities: {} }, () => 0);
  const run = { id: 'alice:1', person: 'alice', scope: 'person', target: 'alice', generation: 1, services: [] } satisfies Parameters<Identity['issue']>[0];
  const environment = identity.issue(run); const service = identity.issue(run); const other = identity.issue({ ...run, id: 'other' }); assert.ok(environment.ok && service.ok && other.ok);
  assert.ok(identity.whois(service.value, environment.value).ok);
  const refused = identity.whois(service.value, other.value); assert.ok(!refused.ok); assert.equal(refused.error.code, 'forbidden');
  identity.fence('alice', 2); const fenced = identity.whois(service.value, environment.value); assert.ok(!fenced.ok); assert.equal(fenced.error.code, 'fenced');
});
