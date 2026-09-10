/** Keep seeded sampling an ordinary provider option rather than a benchmark marker; EV-006. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopFixture } from './loop-fixture.ts';
import type { ModelBegin } from '../contracts/turn-events/types.ts';
import { Schemas } from '../lib/schema/index.ts';
await test('EV-006 ordinary turns forward seeded provider options without a benchmark flag', async () => {
  const f = await loopFixture(); const schemas = new Schemas(); await schemas.load();
  try {
    assert.ok((await f.loop.turn({ text: 'Hello', attachments: [] }, { ...f.options, modelOptions: { seed: 42, temperature: 0 } }, new AbortController().signal)).ok);
    const begun = f.events.find(event => event.type === 'model.begin')?.payload; assert.ok(schemas.validator<ModelBegin>('turn-events', 'modelBegin')(begun));
    const begin = begun.request[0]; assert.ok(begin?.type === 'begin'); assert.deepEqual(begin.options, { seed: 42, temperature: 0 });
    assert.equal(JSON.stringify(begun).includes('benchmark'), false); assert.equal(JSON.stringify(begun).includes('evaluator'), false);
  } finally { await f.close(); }
});

await test('EV-003 an ordinary excluded skill is absent from the stored prefix and remains excluded on reuse', async () => {
  let retrievals = 0;
  const f = await loopFixture([{ source: 'cards', retrieve: () => {
    retrievals++;
    return Promise.resolve({ entries: ['keep', 'withhold'].map(id => ({ id, pack: 'cards', version: '1.0.0', path: `${id}.md`, contentHash: `sha256:${'a'.repeat(64)}`, universal: false, body: id })), dropped: [] });
  } }]);
  try {
    const options = { ...f.options, excludedSkills: ['withhold'] };
    assert.ok((await f.loop.turn({ text: 'Hello', attachments: [] }, options, new AbortController().signal)).ok);
    const first = f.conversation.project().prefix; assert.ok(first);
    assert.deepEqual(first.skills.map(entry => entry.id), ['keep']);
    assert.equal(first.bytes.includes('withhold'), false);
    assert.ok((await f.loop.turn({ text: 'Again', attachments: [] }, options, new AbortController().signal)).ok);
    assert.equal(retrievals, 1); assert.deepEqual(f.conversation.project().prefix, first);
  } finally { await f.close(); }
});
