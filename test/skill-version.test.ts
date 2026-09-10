/** Preserve citations through the stored prefix until an announced refresh; SK-014, ADR 0013. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loopFixture } from '@/test/loop-fixture.ts';
import type { Entry } from '@/contracts/skills/types.ts';

await test('SK-014 changed skill content cannot rewrite an existing conversation prefix before refresh', async () => {
  let current: Entry = { id: 'skill', pack: 'pack', version: '1.0.0', path: 'skill.md', contentHash: `sha256:${'a'.repeat(64)}`, universal: false, body: 'Old skill body.' };
  let retrievals = 0;
  const f = await loopFixture([{ source: 'retrieval', retrieve: () => { retrievals++; return Promise.resolve({ entries: [current], dropped: [] }); } }]);
  try {
    const input = { text: 'Use the skill', attachments: [] }; const signal = new AbortController().signal;
    assert.ok((await f.loop.turn(input, f.options, signal)).ok);
    const stored = f.conversation.project().prefix; assert.ok(stored); assert.equal(stored.skills[0]?.contentHash, current.contentHash);
    current = { ...current, version: '1.0.1', contentHash: `sha256:${'b'.repeat(64)}`, body: 'New skill body.' };
    assert.ok((await f.loop.turn(input, f.options, signal)).ok); assert.equal(retrievals, 1); assert.deepEqual(f.conversation.project().prefix, stored);
    assert.ok((await f.loop.turn(input, { ...f.options, refresh: ['pack'] }, signal)).ok);
    assert.equal(retrievals, 2); assert.equal(f.conversation.project().prefix?.skills[0]?.contentHash, current.contentHash);
    const history = await readFile(join(f.directory, 'conversation.jsonl'), 'utf8');
    assert.ok(history.includes(stored.skills[0].contentHash)); assert.ok(history.includes(current.contentHash));
  } finally { await f.close(); }
});
