/** Exercise framing under arbitrary chunking, unknown fields and bounded queues; KS-018, KS-021. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frames, encode, PriorityFrames } from './index.ts';

async function* chunks(bytes: Uint8Array, width: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += width) { await Promise.resolve(); yield bytes.subarray(i, i + width); }
}

await test('Socket frames with unknown fields round-trip over every small chunk width', async () => {
  for (let seed = 0; seed < 32; seed++) {
    const frame = { id: String(seed), method: 'health.probe', params: {}, future: { unicode: 'λ🌊'.repeat(seed), value: seed * 7919 } };
    const encoded = encode(frame); assert.ok(encoded.ok);
    for (let width = 1; width <= 16; width++) {
      const output: unknown[] = [];
      for await (const result of frames(chunks(encoded.value, width))) output.push(result);
      assert.deepEqual(output, [{ ok: true, value: frame }]);
    }
  }
});

await test('Frame bounds reject oversized, incomplete and invalid UTF-8 input', async () => {
  const oversized = encode({ text: 'x'.repeat(100) }, 32); assert.equal(oversized.ok, false);
  for (const bytes of [Buffer.from('not-json\n'), Buffer.from('{'), Buffer.from([0xff, 10]), Buffer.from('x'.repeat(33))]) {
    const result: {ok: boolean}[] = [];
    for await (const item of frames(chunks(bytes, 1), 32)) result.push(item);
    assert.equal(result.length, 1); assert.equal(result[0]?.ok, false);
  }
  assert.equal(encode(undefined).ok, false);
  assert.equal(encode(1n).ok, false);
});

await test('KS-018 control delivery precedes ten MiB of queued bulk', () => {
  const queue = new PriorityFrames();
  for (let i = 0; i < 10; i++) assert.equal(queue.push(Buffer.alloc(1024 * 1024), false).ok, true);
  const control = Buffer.from('{"method":"session.cancel"}\n');
  assert.equal(queue.push(control, true).ok, true);
  assert.equal(queue.next(), control);
  for (let i = 0; i < 10; i++) assert.equal(queue.next()?.length, 1024 * 1024);
  assert.equal(queue.next(), undefined);
});

await test('Socket queues enforce both item and byte limits', () => {
  const queue = new PriorityFrames({ frameBytes: 4, queueFrames: 1, queueBytes: 4, controlFrames: 0, controlBytes: 0 });
  assert.equal(queue.push(Buffer.alloc(5), false).ok, false);
  assert.equal(queue.push(Buffer.alloc(4), false).ok, true);
  assert.equal(queue.push(Buffer.alloc(0), true).ok, false);
  queue.next();
  assert.equal(queue.push(Buffer.alloc(1), true).ok, true);
});

await test('KS-018 bulk cannot consume the control byte or frame reserve', () => {
  for (const settings of [
    { frameBytes: 4, queueFrames: 8, queueBytes: 8, controlFrames: 1, controlBytes: 4 },
    { frameBytes: 4, queueFrames: 2, queueBytes: 32, controlFrames: 1, controlBytes: 4 }
  ]) {
    const queue = new PriorityFrames(settings); const stop = Buffer.from('stop');
    assert.ok(queue.push(Buffer.alloc(4), false).ok); assert.ok(!queue.push(Buffer.alloc(4), false).ok);
    assert.ok(queue.push(stop, true).ok); assert.equal(queue.next(), stop);
  }
});
