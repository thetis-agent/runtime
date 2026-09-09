/** Pin SSE framing across arbitrary chunks and reject oversized or damaged streams; PR-003. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sse } from './sse.ts';
import { collect, stream } from '../../test/provider-fixture.ts';

await test('SSE preserves Unicode and multiline data under every tested chunk boundary', async () => {
  const bytes = Buffer.from(': comment\r\ndata: α\r\ndata: β\r\n\r\ndata: third\r\r');
  for (let width = 1; width <= bytes.length; width++) {
    const chunks = []; for (let offset = 0; offset < bytes.length; offset += width) chunks.push(bytes.subarray(offset, offset + width));
    assert.deepEqual(await collect(sse(stream(chunks))), [{ ok: true, value: 'α\nβ' }, { ok: true, value: 'third' }]);
  }
});

await test('SSE refuses malformed UTF-8, incomplete events and oversized frames', async () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from('data: partial'), Buffer.from(`data: ${'x'.repeat(32)}\n\n`)]) {
    const events = await collect(sse(stream([bytes]), 16)); assert.ok(events.at(-1)?.ok === false);
  }
});
