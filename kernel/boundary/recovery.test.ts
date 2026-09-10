/** Preserve live conversations and committed pins across supervisor lifetimes; ADR 0030. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { appendFile } from 'node:fs/promises';
import { Runtime } from '@/kernel/boundary/runtime.ts';
import { Identity } from '@/kernel/identity/index.ts';
import { SandboxRunner } from '@/lib/sandbox-runner/index.ts';
import { isObject } from '@/lib/schema/index.ts';
import { runtimeFixture, people } from '@/test/runtime-fixture.ts';

await test('ADR-0030 supervisor restart restores committed pins and conversations under a fresh epoch', async () => {
  const f = await runtimeFixture(); const person = people[0]; assert.ok(person);
  const identity = new Identity({ people, bindings: [], authorities: {} }, () => f.clock.now());
  const runtime = new Runtime({ root: join(f.root, 'targets'), recoveryJournal: join(f.root, 'observed.jsonl'), identity, journal: f.journal, schemas: f.schemas, clock: f.clock, runner: new SandboxRunner('/cgroup') });
  try {
    const target = await f.environment(person.id); assert.ok((await f.runtime.start(target)).ok);
    const created = await f.runtime.session(person, 'session.create', { surface: 'recovery' }); assert.ok(created.ok && isObject(created.value));
    const conversation = created.value['id']; assert.equal(typeof conversation, 'string');
    assert.ok((await f.runtime.session(person, 'session.submit', { conversation, input: { text: 'Before restart', attachments: [] } })).ok);
    assert.ok((await f.runtime.switch({ ...person, role: 'admin' }, f.shared, 1)).ok);
    assert.ok((await f.runtime.close()).ok);
    for (const pin of Object.values(f.shared.revision.pins)) pin.hash = `sha256:${'0'.repeat(64)}`;
    const started = await runtime.start(f.shared); assert.ok(started.ok, JSON.stringify(started));
    const environment = await runtime.start(target); assert.ok(environment.ok, JSON.stringify(environment));
    const status = runtime.status({ ...person, role: 'admin' }, f.shared.id); assert.ok(status.ok); assert.equal(status.value['generation'], 3);
    const listed = await runtime.session(person, 'session.list', {}); assert.ok(listed.ok); assert.ok(JSON.stringify(listed.value).includes(String(conversation)));
    const continued = await runtime.session(person, 'session.submit', { conversation, input: { text: 'After restart', attachments: [] } }); assert.ok(continued.ok, JSON.stringify(continued));
    assert.match(await f.rows(), /"event":"restart"/u);
  } finally { assert.ok((await runtime.close()).ok); await f.close(); }
});

await test('ADR-0030 observed history without a checkpoint refuses restart before admitting a process', async () => {
  const f = await runtimeFixture();
  try {
    await appendFile(join(f.root, 'observed.jsonl'), `${JSON.stringify({ provenance: 'kernel-observed', at: 0, target: 'missing', kind: 'generation.initial', data: { snapshot: { state: 'LIVE', current: { n: 9, pins: {}, stateSnapshot: '', prefixRenderer: '1', at: 0 }, since: 0 } } })}\n`);
    const runtime = new Runtime({ root: join(f.root, 'targets'), recoveryJournal: join(f.root, 'observed.jsonl'), identity: f.identity, journal: f.journal, schemas: f.schemas, clock: f.clock, runner: new SandboxRunner('/cgroup') });
    const result = await runtime.start({ ...f.shared, id: 'missing' }); assert.ok(!result.ok); assert.equal(result.error.code, 'io');
    assert.equal((await f.rows()).includes('"target":"missing","kind":"process.start"'), false);
  } finally { await f.close(); }
});
