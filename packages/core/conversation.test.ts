/** Keep branch ids and protected history durable without rewriting prior records; TE-030. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Schemas } from '../../lib/schema/index.ts';
import { Conversation, compact } from './conversation.ts';
import type { Message } from '../../contracts/turn-events/types.ts';

await test('Conversation JSONL preserves id/parentId branches across reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'thetis-history-'));
  const schema = new Schemas(); await schema.load();
  const path = join(root, 'conversation.jsonl');
  let id = 0;
  const conversation = new Conversation(path, schema, () => String(++id));
  const message: Message = { role: 'user', source: 'core', content: [{ type: 'text', text: 'root' }] };
  try {
    assert.ok((await conversation.load()).ok);
    const rootRow = await conversation.append({ type: 'message', value: message }); assert.ok(rootRow.ok);
    const before = await readFile(path, 'utf8');
    const a = await conversation.append({ type: 'message', value: { ...message, content: [{ type: 'text', text: 'branch-a' }] } }); assert.ok(a.ok);
    const b = await conversation.append({ type: 'message', value: { ...message, content: [{ type: 'text', text: 'branch-b' }] } }, rootRow.value.id); assert.ok(b.ok);
    assert.ok((await readFile(path, 'utf8')).startsWith(before));
    assert.equal(conversation.project(a.value.id).history.length, 2);
    const reloaded = new Conversation(path, schema); assert.ok((await reloaded.load()).ok);
    assert.deepEqual(reloaded.project(), conversation.project(b.value.id));
    assert.ok(!JSON.stringify(reloaded.project()).includes('branch-a'));
  } finally { await rm(root, { recursive: true }); }
});

await test('TE-030 compaction preserves protected entries and leaves source history untouched', () => {
  const history: Message[] = Array.from({ length: 20 }, (_, i) => ({ role: 'user', source: 'core', content: [{ type: 'text', text: String(i) }], protected: i === 0 }));
  const view = compact(history, 2);
  assert.equal(view.length, 3); assert.deepEqual(view[0], history[0]);
  assert.equal(history.length, 20); assert.notEqual(view[0], history[0]);
});
