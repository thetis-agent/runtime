/** Preserve normalized provider reasoning and the last usage counters; TE-028, PR-015. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopFixture } from './loop-fixture.ts';

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
