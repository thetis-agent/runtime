/** Deliver private token batches directly while inherited submission remains observed; KS-004, ADR 0019. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { serviceFixture } from '@/test/provider-service.ts';
import { environmentProcess } from '@/test/environment-process.ts';
import { SessionClient } from '@/lib/session/client.ts';
import type { Batch } from '@/lib/session/types.ts';
import { Schemas, isObject } from '@/lib/schema/index.ts';
import { ManualClock } from '@/lib/events/index.ts';

await test('KS-004 direct subscriptions deliver batched tokens and end without exposing content to kernel control', async () => {
  const shared = await serviceFixture(1, { scripts: [Array.from({ length: 1000 }, () => ({ type: 'delta.text', text: 'PRIVATE_STREAM_TEXT' }))] }); assert.ok((await shared.process.probe()).ok);
  const alice = await environmentProcess(shared, 'alice', true); const bob = await environmentProcess(shared, 'bob', true);
  const schemas = new Schemas(); await schemas.load(); const clock = new ManualClock(); const batches: Batch[] = [];
const created = await alice.process.invoke('session.create', { surface: 'faux-gateway' }); assert.ok(created.ok && isObject(created.value)); const id = created.value['id']; assert.ok(typeof id === 'string');
  assert.ok((await bob.process.invoke('session.list', {})).ok);
  const client = await SessionClient.open(join(alice.root, 'endpoint/service.sock'), schemas, clock, batch => { batches.push(batch); return Promise.resolve({ ok: true, value: undefined }); }); assert.ok(client.ok);
  const other = await SessionClient.open(join(bob.root, 'endpoint/service.sock'), schemas, clock, () => Promise.resolve({ ok: true, value: undefined })); assert.ok(other.ok);
  try {
    assert.ok((await client.value.subscribe(id)).ok);
    const wrong = await other.value.subscribe(id); assert.ok(!wrong.ok); assert.equal(wrong.error.code, 'not-found');
    const direct = await client.value.peer.call('session.submit', { conversation: id, input: { text: 'Bypass', attachments: [] } }); assert.ok(!direct.ok); assert.equal(direct.error.code, 'forbidden');
    assert.ok((await alice.process.invoke('session.submit', { conversation: id, input: { text: 'Hello', attachments: [] } })).ok);
    assert.ok((await client.value.end()).ok); const events = batches.flatMap(batch => batch.events);
    assert.equal(events.filter(event => event.type === 'token').length, 1000); assert.equal(events.at(-1)?.type, 'end'); assert.ok(batches.length < 100);
    const rows = await alice.rows(); assert.ok(rows.includes('turn.start')); assert.ok(rows.includes('turn.end')); assert.ok(!rows.includes('PRIVATE_STREAM_TEXT')); assert.ok(!(await shared.rows()).includes('PRIVATE_STREAM_TEXT'));
  } finally { client.value.close(); other.value.close(); await alice.close(); await bob.close(); await shared.close(); }
});
