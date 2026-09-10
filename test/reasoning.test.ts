/** Preserve normalized provider reasoning and the last usage counters; TE-028, PR-015. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopFixture } from '@/test/loop-fixture.ts';

await test('TE-028 opaque reasoning survives history and returns in the next request', async () => {
  const fixture = await loopFixture([], [[{ type: 'delta.reasoning', text: 'thinking', opaque: { signature: 'opaque-marker' } }, { type: 'delta.text', text: 'answer' }]]);
  try {
    await fixture.loop.turn({ text: 'Hello', attachments: [] }, fixture.options, new AbortController().signal);
    await fixture.loop.turn({ text: 'Again', attachments: [] }, fixture.options, new AbortController().signal);
    assert.ok(JSON.stringify(fixture.conversation.project().history).includes('opaque-marker'));
    const next = fixture.events.filter(event => event.type === 'model.begin').at(-1);
    assert.ok(JSON.stringify(next).includes('opaque-marker'));
  } finally { await fixture.close(); }
});

await test('PR-015 model.end records the last usage counters unchanged', async () => {
  const counters = { cost: 0.003, custom: 17 };
  const fixture = await loopFixture([], [[{ type: 'usage', counters: { cost: 0.001 } }, { type: 'usage', counters }]]);
  try {
    await fixture.loop.turn({ text: 'Hello', attachments: [] }, fixture.options, new AbortController().signal);
    assert.deepEqual(fixture.events.find(event => event.type === 'model.end')?.payload['usage'], counters);
  } finally { await fixture.close(); }
});

await test('ADR-0024 assistant tool calls and reasoning precede results in persisted and replayed history', async () => {
  const fixture = await loopFixture([{
    source: 'test-files@1',
    offer: () => Promise.resolve([{ name: 'read_path', description: 'Read', readOnly: true, endsTurn: false, source: 'test-files@1', schema: { type: 'object' } }]),
    call: request => Promise.resolve({ id: request.id, ok: true, content: [{ type: 'text', text: 'tool result' }] })
  }], [[
    { type: 'delta.reasoning', opaque: 'signed-reasoning' },
    { type: 'delta.tool_call', callId: 'call-a', name: 'read_path', args: '{' },
    { type: 'delta.tool_call', callId: 'call-a', args: '}' }
  ], [{ type: 'delta.text', text: 'done' }]]);
  try {
    const result = await fixture.loop.turn({ text: 'Read it', attachments: [] }, fixture.options, new AbortController().signal);
    assert.ok(result.ok);
    assert.equal(fixture.provider.reports.length, 2);
    assert.equal(new Set(fixture.provider.reports.map(row => row.callId)).size, 2);
    const history = fixture.conversation.project().history;
    assert.deepEqual(history.map(message => message.role), ['user', 'assistant', 'tool', 'assistant']);
    assert.deepEqual(history[1]?.content, [{ type: 'reasoning', opaque: 'signed-reasoning' }, { type: 'tool_call', id: 'call-a', name: 'read_path', args: '{}' }]);
    assert.equal(history[2]?.toolCallId, 'call-a');
    const second = fixture.events.filter(event => event.type === 'model.begin')[1]; assert.ok(second);
    assert.ok(JSON.stringify(second.payload).includes('signed-reasoning')); assert.ok(JSON.stringify(second.payload).includes('tool_call'));
    const loaded = await fixture.conversation.load(); assert.ok(loaded.ok);
    assert.deepEqual(fixture.conversation.project().history, history);
  } finally { await fixture.close(); }
});

await test('Tool call ids that escape artifact paths are refused before invoking a handler', async () => {
  let called = false;
  const fixture = await loopFixture([{
    source: 'test-files@1',
    offer: () => Promise.resolve([{ name: 'read_path', description: 'Read', readOnly: true, endsTurn: false, source: 'test-files@1', schema: { type: 'object' } }]),
    call: request => { called = true; return Promise.resolve({ id: request.id, ok: true }); }
  }], [[{ type: 'delta.tool_call', callId: '../../outside', name: 'read_path', args: '{}' }], [{ type: 'delta.text', text: 'done' }]]);
  try {
    assert.ok((await fixture.loop.turn({ text: 'Read', attachments: [] }, fixture.options, new AbortController().signal)).ok);
    assert.equal(called, false);
    assert.ok(JSON.stringify(fixture.events.filter(event => event.type === 'call')).includes('outside-roots'));
  } finally { await fixture.close(); }
});

await test('ADR-0024 endsTurn answers remaining calls without executing them', async () => {
  const called: string[] = [];
  const fixture = await loopFixture([{
    source: 'test-files@1',
    offer: () => Promise.resolve([{ name: 'finish', description: 'Finish', readOnly: true, endsTurn: true, source: 'test-files@1', schema: { type: 'object' } }]),
    call: request => { called.push(request.id); return Promise.resolve({ id: request.id, ok: true }); }
  }], [[{ type: 'delta.tool_call', callId: 'first', name: 'finish', args: '{}' }, { type: 'delta.tool_call', callId: 'second', name: 'finish', args: '{}' }]]);
  try {
    assert.ok((await fixture.loop.turn({ text: 'Finish', attachments: [] }, fixture.options, new AbortController().signal)).ok);
    assert.deepEqual(called, ['first']);
    assert.deepEqual(fixture.conversation.project().history.filter(message => message.role === 'tool').map(message => message.toolCallId), ['first', 'second']);
    assert.equal(fixture.provider.provider.vendorCalls, 1);
  } finally { await fixture.close(); }
});
