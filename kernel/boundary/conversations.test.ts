/** Cover the conversation metadata the kernel socket now carries: renaming, archiving, and the list
 * that can answer for the archive or for everyone; KS-004, contract/kernel-socket 1.2.0. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeFixture, people } from '@/test/runtime-fixture.ts';
import { Schemas, isObject } from '@/lib/schema/index.ts';
import type { Principal } from '@/kernel/identity/index.ts';

/** Someone whose role may observe others. Built here rather than taken from the fixture's people, who
 * are deliberately ordinary: the two checks this exercises are the role's and nothing else's. */
const observer: Principal = { id: 'operator', role: 'admin', projects: [], observeOthers: true };

const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(isObject) : [];

await test('a conversation can be renamed and archived over the socket, and an ordinary list stops showing it', async () => {
  const fixture = await runtimeFixture();
  try {
    const person = people[0]; assert.ok(person);
    assert.ok((await fixture.runtime.start(await fixture.environment(person.id))).ok);
    const created = await fixture.runtime.session(person, 'session.create', { surface: 'headless' });
    assert.ok(created.ok && isObject(created.value)); const id = created.value['id']; assert.ok(typeof id === 'string');

    assert.ok((await fixture.runtime.session(person, 'session.rename', { conversation: id, title: 'Quarterly plan' })).ok);
    const named = await fixture.runtime.session(person, 'session.list', {}); assert.ok(named.ok);
    assert.deepEqual(rows(named.value).map(row => row['title']), ['Quarterly plan']);

    assert.ok((await fixture.runtime.session(person, 'session.archive', { conversation: id, archived: true })).ok);
    const live = await fixture.runtime.session(person, 'session.list', {}); assert.ok(live.ok);
    assert.deepEqual(rows(live.value), [], 'an archived conversation is out of the way until the list asks for it.');
    const both = await fixture.runtime.session(person, 'session.list', { archived: true }); assert.ok(both.ok);
    assert.deepEqual(rows(both.value).map(row => [row['id'], row['archived']]), [[id, true]]);

    assert.ok((await fixture.runtime.session(person, 'session.archive', { conversation: id, archived: false })).ok);
    const restored = await fixture.runtime.session(person, 'session.list', {}); assert.ok(restored.ok);
    assert.deepEqual(rows(restored.value).map(row => row['id']), [id]);

    for (const params of [{ conversation: id }, { conversation: id, title: '' }, { conversation: id, archived: 'yes' }]) {
      const refused = await fixture.runtime.session(person, 'archived' in params ? 'session.archive' : 'session.rename', params);
      assert.ok(!refused.ok, JSON.stringify(params)); assert.equal(refused.error.code, 'invalid-args');
    }
  } finally { await fixture.close(); }
});

await test('everyone\'s conversations are gathered from every running environment and stamped with whose they are', async () => {
  const fixture = await runtimeFixture();
  try {
    const owners = new Map<string, string>();
    for (const person of people) {
      assert.ok((await fixture.runtime.start(await fixture.environment(person.id))).ok);
      const created = await fixture.runtime.session(person, 'session.create', { surface: 'headless' });
      assert.ok(created.ok && isObject(created.value)); const id = created.value['id']; assert.ok(typeof id === 'string');
      owners.set(id, person.id);
    }
    const everyone = await fixture.runtime.session(observer, 'session.list', { person: '*' }); assert.ok(everyone.ok);
    assert.deepEqual(new Map(rows(everyone.value).map(row => [row['id'], row['owner']])), owners,
      'a row carries no owner of its own, so the fan-out is what says whose conversation each one is.');

    const alice = people[0]; assert.ok(alice);
    const refused = await fixture.runtime.session(alice, 'session.list', { person: '*' });
    assert.ok(!refused.ok); assert.equal(refused.error.code, 'forbidden',
      'the reserved name is refused exactly as any other person\'s name is refused to a role that may not observe others.');
  } finally { await fixture.close(); }
});

await test('the contract refuses a rename or an archive that is missing its argument', async () => {
  const schemas = new Schemas(); await schemas.load();
  const reference = 'thetis://contract/kernel-socket/1#/$defs/params/';
  const rename = schemas.compile({ $ref: `${reference}session.rename` });
  const archive = schemas.compile({ $ref: `${reference}session.archive` });
  const list = schemas.compile({ $ref: `${reference}session.list` });
  assert.ok(rename({ conversation: 'c1', title: 'A name' }));
  assert.ok(!rename({ conversation: 'c1' })); assert.ok(!rename({ conversation: 'c1', title: '' }));
  assert.ok(!rename({ conversation: 'c1', title: 'x'.repeat(97) }), 'the wire cap matches the stored title\'s.');
  assert.ok(archive({ conversation: 'c1', archived: false }));
  assert.ok(!archive({ conversation: 'c1' })); assert.ok(!archive({ conversation: 'c1', archived: 'yes' }));
  assert.ok(list({}) && list({ archived: true }) && list({ person: '*' }));
  assert.ok(!list({ archived: 'yes' }));
});
