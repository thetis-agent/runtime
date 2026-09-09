/** Pin scoped identities, prefix persistence, cancellation and drain against the real loop; KS-004, TE-009. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Sessions, sessionLimits } from './sessions.ts';
import { sessionFixture } from '../../test/session-fixture.ts';
import type { Vendor } from '../../lib/provider/engine.ts';

const input = { text: 'Hello', attachments: [] };

await test('KS-004 conversation ids resolve only inside the assigned environment state', async () => {
  const alice = await sessionFixture(); const bob = await sessionFixture();
  try {
    const a = await alice.sessions.create({ surface: 'web' }); const b = await bob.sessions.create({ surface: 'web' }); assert.ok(a.ok && b.ok);
    assert.ok(!(await alice.sessions.history(b.value.id)).ok); assert.ok(!(await bob.sessions.submit(a.value.id, input)).ok);
    assert.ok(!(await alice.sessions.history('../conversations')).ok);
    assert.deepEqual(await readdir(alice.state), [a.value.id]); assert.deepEqual(await readdir(bob.state), [b.value.id]);
    assert.deepEqual(await alice.sessions.list(), { ok: true, value: [a.value] });
    const alias = '00000000-0000-0000-0000-000000000001'; await symlink(join(bob.state, b.value.id), join(alice.state, alias));
    const escaped = await alice.sessions.history(alias); assert.ok(!escaped.ok); assert.equal(escaped.error.code, 'outside-roots');
  } finally { await alice.close(); await bob.close(); }
});

await test('TE-009 session reload reuses the stored prefix and returns completion metadata without provider content', async () => {
  const f = await sessionFixture();
  try {
    const created = await f.sessions.create({ surface: 'web' }); assert.ok(created.ok);
    const first = await f.sessions.submit(created.value.id, input); assert.ok(first.ok); assert.deepEqual(Object.keys(first.value).sort(), ['conversation', 'head']);
    const reopened = await Sessions.open(f.state, f.runtime); assert.ok(reopened.ok);
    const second = await reopened.value.submit(created.value.id, { text: 'Again', attachments: [] }); assert.ok(second.ok); assert.notEqual(first.value.head, second.value.head);
    const history = await reopened.value.history(created.value.id); assert.ok(history.ok); assert.deepEqual(history.value.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
    assert.equal(f.events.filter(event => event.type === 'retrieve').length, 1);
    assert.equal(f.provider.provider.capturedPrefixes[0], f.provider.provider.capturedPrefixes[1]);
    assert.ok(!JSON.stringify(history.value).includes('ignored extension'));
    assert.equal(f.provider.reports.length, 2);
  } finally { await f.close(); }
});

await test('GN-001 session drain waits for active writes, refuses new turns and permits cancellation before resumption', async () => {
  const entered = Promise.withResolvers<AbortSignal>(); const release = Promise.withResolvers<undefined>();
  const vendor: Vendor = {
    describe: () => Promise.resolve({ ok: true, value: { models: [] } }), estimate: () => 0.01,
    async *exchange(_request, signal) {
      entered.resolve(signal); signal.addEventListener('abort', () => { release.resolve(undefined); }, { once: true });
      yield { type: 'start', id: 'call', model: 'scripted' }; await release.promise;
      yield { type: 'usage', counters: { cost: 0.001 } }; yield { type: 'stop', reason: 'end' };
    }
  };
  const f = await sessionFixture(vendor);
  try {
    const created = await f.sessions.create({ surface: 'web' }); assert.ok(created.ok);
    const turn = f.sessions.submit(created.value.id, input); const signal = await entered.promise;
    const duplicate = await f.sessions.submit(created.value.id, input); assert.ok(!duplicate.ok); assert.equal(duplicate.error.code, 'budget');
    const creating = f.sessions.create({ surface: 'web' }); const drained = f.sessions.pause();
    const refused = await f.sessions.submit(created.value.id, input); assert.ok(!refused.ok); assert.equal(refused.error.code, 'switching');
    assert.ok(!(await f.sessions.create({ surface: 'web' })).ok); assert.equal(f.sessions.active, 1);
    assert.deepEqual(f.sessions.cancel(created.value.id), { ok: true, value: { cancelled: true } }); assert.ok(signal.aborted);
    assert.ok((await turn).ok); await drained; assert.ok((await creating).ok); assert.equal(f.sessions.active, 0);
    f.sessions.resume(); assert.ok((await f.sessions.submit(created.value.id, input)).ok);
  } finally { release.resolve(undefined); await f.close(); }
});

await test('Session metadata, input size, loading size and concurrent read queues refuse before unbounded work', async () => {
  const f = await sessionFixture();
  try {
    assert.ok(!(await f.sessions.create({ surface: '' })).ok);
    const creating = f.sessions.create({ surface: 'web' }); assert.ok(!(await f.sessions.create({ surface: 'web' })).ok);
    const created = await creating; assert.ok(created.ok);
    const large = await f.sessions.submit(created.value.id, { text: 'x'.repeat(sessionLimits.inputBytes), attachments: [] }); assert.ok(!large.ok); assert.equal(large.error.code, 'budget');
    const reads = Array.from({ length: sessionLimits.reads }, () => f.sessions.list());
    const extra = await f.sessions.list(); assert.ok(!extra.ok); assert.equal(extra.error.code, 'budget'); await Promise.all(reads);
    await writeFile(join(f.state, created.value.id, 'conversation.jsonl'), 'x'.repeat(sessionLimits.fileBytes + 1));
    const loaded = await f.sessions.history(created.value.id); assert.ok(!loaded.ok); assert.equal(loaded.error.code, 'budget');
    await writeFile(join(f.state, created.value.id, 'metadata.json'), JSON.stringify({ id: created.value.id, surface: 4 }));
    const listed = await f.sessions.list(); assert.ok(!listed.ok); assert.equal(listed.error.code, 'io');
  } finally { await f.close(); }
});
