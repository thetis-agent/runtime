/** Test event order and stored-prefix behavior through complete turns; TE-001, TE-009–011. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loopFixture } from '../../../test/loop-fixture.ts';
import { renderPrefix } from '../../../packages/core/prefix.ts';
import type { Stage } from '../../../lib/events/stages.ts';

await test('TE-001 a base turn preserves event order and iteration numbering', async () => {
  const fixture = await loopFixture();
  try {
    assert.ok((await fixture.loop.turn({ text: 'Hello', attachments: [] }, fixture.options, new AbortController().signal)).ok);
    const structural = fixture.events.filter(event => event.type !== 'model.event' && event.type !== 'token');
    assert.deepEqual(structural.map(event => event.type), ['input', 'retrieve', 'context', 'offer', 'model.begin', 'model.end', 'output', 'end']);
    for (const event of fixture.events) assert.equal(event.iteration, ['input', 'retrieve', 'end'].includes(event.type) ? 0 : 1);
    assert.equal(fixture.events.at(-1)?.payload['iterations'], 1);
  } finally { await fixture.close(); }
});

await test('TE-009 prefix is stored once and turn two neither retrieves nor changes its bytes', async () => {
  let retrieved = 0;
  const stage: Stage = { source: 'retrieval', retrieve: () => { retrieved++; return Promise.resolve({ entries: [], dropped: [] }); } };
  const fixture = await loopFixture([stage]);
  try {
    assert.ok((await fixture.loop.turn({ text: 'Hello', attachments: [] }, fixture.options, new AbortController().signal)).ok);
    const prefix = fixture.conversation.project().prefix; assert.ok(prefix);
    assert.ok((await fixture.loop.turn({ text: 'Again', attachments: [] }, fixture.options, new AbortController().signal)).ok);
    assert.equal(retrieved, 1);
    assert.deepEqual(fixture.conversation.project().prefix, prefix);
    const records = (await readFile(join(fixture.directory, 'conversation.jsonl'), 'utf8')).trim().split('\n').map((line): unknown => JSON.parse(line));
    assert.equal(records.filter(row => typeof row === 'object' && row !== null && 'type' in row && row.type === 'prefix').length, 1);
    assert.equal(fixture.provider.provider.capturedPrefixes[0], fixture.provider.provider.capturedPrefixes[1]);
    assert.deepEqual(renderPrefix(fixture.options.system, [], []), renderPrefix(fixture.options.system, [], []));
  } finally { await fixture.close(); }
});

await test('TE-010 an announced profile change refreshes once and records one history line', async () => {
  let retrieved = 0;
  const fixture = await loopFixture([{ source: 'retrieval', retrieve: () => { retrieved++; return Promise.resolve({ entries: [], dropped: [] }); } }]);
  try {
    await fixture.loop.turn({ text: 'Hello', attachments: [] }, fixture.options, new AbortController().signal);
    await fixture.loop.turn({ text: 'Again', attachments: [] }, { ...fixture.options, refresh: ['changed-package'] }, new AbortController().signal);
    assert.equal(retrieved, 2);
    assert.equal(fixture.conversation.project().history.filter(message => message.role === 'system').length, 1);
    assert.equal(fixture.events.at(-1)?.payload['reason'], 'answer');
  } finally { await fixture.close(); }
});

await test('TE-011 appended context contributes to the request but is never persisted', async () => {
  const fixture = await loopFixture([{ source: 'notes', context: append => { append({ role: 'system', source: 'forged', content: [{ type: 'text', text: 'ephemeral-only-marker' }] }); } }]);
  try {
    assert.ok((await fixture.loop.turn({ text: 'Hello', attachments: [] }, fixture.options, new AbortController().signal)).ok);
    assert.ok(JSON.stringify(fixture.events.find(event => event.type === 'model.begin')).includes('ephemeral-only-marker'));
    assert.ok(!(await readFile(join(fixture.directory, 'conversation.jsonl'), 'utf8')).includes('ephemeral-only-marker'));
  } finally { await fixture.close(); }
});
