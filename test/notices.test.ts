/** Keep notices between turns and preserve a non-waking conversation; TE-029. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopFixture } from './loop-fixture.ts';

await test('TE-029 wake requests wait for the next input when waking is disabled', async () => {
  const fixture = await loopFixture();
  try {
    assert.ok(fixture.loop.notice('background', { content: [{ type: 'text', text: 'completed' }], wake: true }).ok);
    assert.equal(fixture.events.length, 0);
    assert.equal(fixture.conversation.project().history.length, 0);
    assert.ok((await fixture.loop.turn({ text: 'Hello', attachments: [] }, fixture.options, new AbortController().signal)).ok);
    assert.equal(fixture.conversation.project().history[0]?.source, 'background');
    assert.equal(fixture.events.filter(event => event.type === 'input').length, 1);
  } finally { await fixture.close(); }
});
