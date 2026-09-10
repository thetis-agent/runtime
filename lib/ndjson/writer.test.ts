/** Assert priority on the actual wire rather than only inside the queue; KS-018. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameWriter } from './writer.ts';
import { socketFrames } from './socket.ts';
import { socketPair } from '@/test/socket-pair.ts';

await test('KS-018 a control frame precedes ten MiB of queued bulk on the socket', async () => {
  const pair = await socketPair(); const writer = new FrameWriter(pair.client); const frames = socketFrames(pair.peer);
  try {
    const writes = Array.from({ length: 20 }, () => writer.write({ bulk: 'x'.repeat(512 * 1024) }));
    writes.push(writer.write({ note: 'run.stop', params: {} }, true));
    const first = await frames.next(); assert.equal(first.done, false);
    assert.deepEqual(first.value, { ok: true, value: { note: 'run.stop', params: {} } });
    for (let index = 0; index < 20; index++) { const next = await frames.next(); assert.ok(!next.done); assert.ok(next.value.ok); }
    assert.ok((await Promise.all(writes)).every(result => result.ok));
  } finally { writer.close(); await writer.settled(); await pair.close(); }
});
