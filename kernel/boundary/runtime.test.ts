/** Route two people through the assembled kernel while keeping model content inside environments; KS-004–005, KS-023. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeFixture, people } from '../../test/runtime-fixture.ts';
import { isObject } from '../../lib/schema/index.ts';
import { connect } from '../../lib/ndjson/socket.ts';
import { Peer } from '../../lib/socket/index.ts';
import { clock } from '../../lib/events/index.ts';
import { sessionWhois } from './runtime.ts';
import { Identity } from '../identity/index.ts';
import type { Run } from '../identity/index.ts';

for (const id of ['KS-004', 'KS-005']) await test(`${id} the kernel assembles isolated person-owned sessions and refuses cross-person submission`, async () => {
  const fixture = await runtimeFixture();
  try {
    const ids: string[] = [];
    for (const person of people) {
      const target = await fixture.environment(person.id); const started = await fixture.runtime.start(target); assert.ok(started.ok, JSON.stringify(started));
      const created = await fixture.runtime.session(person, 'session.create', { surface: 'headless' }); assert.ok(created.ok && isObject(created.value), JSON.stringify(created)); const id = created.value['id']; assert.ok(typeof id === 'string'); ids.push(id);
      for (let turn = 0; turn < 2; turn++) assert.ok((await fixture.runtime.session(person, 'session.submit', { conversation: id, input: { text: 'Private greeting', attachments: [] } })).ok);
      const endpoint = fixture.runtime.endpoint(person.id); assert.ok(endpoint.ok); const socket = await connect(endpoint.value); assert.ok(socket.ok);
      const client = new Peer(socket.value, fixture.schemas, clock, ['session.list'], { handlers: new Map(), note: () => Promise.resolve({ ok: true, value: undefined }) });
      assert.ok((await client.connect()).ok); const listed = await client.call('session.list', {}); assert.ok(listed.ok); assert.ok(JSON.stringify(listed.value).includes(id)); client.close(); await client.finished();
    }
    const alice = people[0]; const other = ids[1]; assert.ok(alice && other);
    const refused = await fixture.runtime.session(alice, 'session.submit', { conversation: other, input: { text: 'cross-person', attachments: [] } }); assert.ok(!refused.ok);
    const log = await fixture.rows(); assert.equal(log.split('\n').filter(row => row.includes('"kind":"turn.report"')).length, 4); assert.ok(!log.includes('Private greeting')); assert.ok(!log.includes('Hello.'));
    for (const kind of ['turn.start', 'turn.end']) assert.equal(log.split('\n').filter(row => row.includes('"provenance":"kernel-observed"') && row.includes(`"kind":"${kind}"`)).length, 5);
    assert.equal(log.split('\n').filter(row => row.includes('"kind":"turn.end"') && row.includes('"outcome":"error"')).length, 1);
  } finally { await fixture.close(); }
});

await test('KS-019 status answers for a refused environment without attempting another start', async () => {
  const fixture = await runtimeFixture();
  try {
    const person = people[0]; assert.ok(person); const target = await fixture.environment(person.id);
    for (const pin of Object.values(target.revision.pins)) pin.hash = `sha256:${'0'.repeat(64)}`;
    assert.ok(!(await fixture.runtime.start(target)).ok);
    const before = await fixture.rows(); const status = fixture.runtime.status(person, target.id);
    assert.ok(status.ok); assert.equal(status.value['state'], 'FAILED'); assert.equal(status.value['ready'], false);
    assert.equal(await fixture.rows(), before);
  } finally { await fixture.close(); }
});

await test('GN-004 directory-mounted callers retain reviewed accounting after a service generation changes', async () => {
  const fixture = await runtimeFixture();
  try {
    const person = people[0]; assert.ok(person); const target = await fixture.environment(person.id);
    assert.ok((await fixture.runtime.start(target)).ok);
    const created = await fixture.runtime.session(person, 'session.create', { surface: 'headless' }); assert.ok(created.ok && isObject(created.value));
    const conversation = created.value['id']; assert.equal(typeof conversation, 'string');
    const input = { conversation, input: { text: 'same caller', attachments: [] } };
    assert.ok((await fixture.runtime.session(person, 'session.submit', input)).ok);
    assert.ok((await fixture.runtime.switch({ ...person, role: 'admin' }, fixture.shared, 1)).ok);
    const next = await fixture.runtime.session(person, 'session.submit', input); assert.ok(next.ok, JSON.stringify(next));
    const rows = (await fixture.rows()).trim().split('\n');
    assert.equal(rows.filter(row => row.includes('"provenance":"reviewed-reported"')).length, 2);
    assert.equal(rows.filter(row => row.includes('"kind":"turn.report"')).length, 2);
  } finally { await fixture.close(); }
});

await test('KS-023 session.whois answers a deployment caller for any person and a person caller only for itself, and never leaks the token', () => {
  const identity = new Identity({ people, bindings: people.map(person => ({ kind: 'password', id: person.id, person: person.id })), authorities: { password: 'authority' } }, () => 0);
  const alice = people[0]; const bob = people[1]; assert.ok(alice && bob);
  const aliceToken = identity.session('authority', 'password', alice.id); assert.ok(aliceToken.ok);
  const bobToken = identity.session('authority', 'password', bob.id); assert.ok(bobToken.ok);
  const deploymentRun: Run = { id: 'shared-run', person: '', scope: 'deployment', target: 'shared', generation: 1, expires: 0, services: [] };
  const aliceRun: Run = { id: 'alice-run', person: alice.id, scope: 'person', target: alice.id, generation: 1, expires: 0, services: [] };

  const asDeployment = sessionWhois(identity, deploymentRun, aliceToken.value.sessionToken);
  assert.deepEqual(asDeployment, { ok: true, value: { person: 'alice', role: 'user' } });

  const ownSession = sessionWhois(identity, aliceRun, aliceToken.value.sessionToken);
  assert.deepEqual(ownSession, { ok: true, value: { person: 'alice', role: 'user' } });

  const foreign = sessionWhois(identity, aliceRun, bobToken.value.sessionToken);
  assert.ok(!foreign.ok); assert.equal(foreign.error.code, 'forbidden');

  const unknown = sessionWhois(identity, deploymentRun, 'never-issued');
  assert.ok(!unknown.ok); assert.equal(unknown.error.code, 'auth');

  const missing = sessionWhois(identity, deploymentRun, 42);
  assert.ok(!missing.ok); assert.equal(missing.error.code, 'auth');

  for (const result of [asDeployment, ownSession]) assert.equal(JSON.stringify(result).includes(aliceToken.value.sessionToken), false);
  // session.whois never journals or logs: its Runtime handler only calls Identity.resolveSession and returns a value, with no
  // call into Journal/Usage anywhere on its path (see kernel/boundary/runtime.ts's methods.set('session.whois', ...)), so there
  // is no log row to inspect here — unlike KS-004/005/GN-004 above, which assert directly against fixture.rows().
});
