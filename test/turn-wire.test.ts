/** Compare gateway observations with the actual provider socket edge; TE-027. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loopFixture } from '@/test/loop-fixture.ts';
import { listen } from '@/lib/provider/server.ts';
import { ProviderClient } from '@/lib/provider/client.ts';
import { Schemas } from '@/lib/schema/index.ts';
import { ManualClock } from '@/lib/events/index.ts';
import type { Provider } from '@/lib/provider/index.ts';
import type { RequestEvent } from '@/contracts/provider/types.ts';
import type { Envelope } from '@/contracts/turn-events/types.ts';
import { Loop } from '@/packages/core/index.ts';

await test('TE-027 model.begin contains exactly the events received on the provider socket', async () => {
  const f = await loopFixture(); const schemas = new Schemas(); await schemas.load();
  const captured: RequestEvent[] = []; const events: Envelope[] = [];
  const vendor: Provider = { describe: () => f.provider.provider.describe(), run(request, token, signal) {
    const forwarded = { async *[Symbol.asyncIterator]() { for await (const frame of request) { assert.ok(captured.length < 256); captured.push(frame); yield frame; } } };
    return f.provider.provider.run(forwarded, token, signal);
  } };
  const path = join(f.directory, 'provider.sock'); const opened = await listen(path, vendor, schemas, result => { assert.ok(result.ok, JSON.stringify(result)); }); assert.ok(opened.ok);
  try {
    const loop = new Loop([{ source: 'gateway', observe(event) { events.push(event); } }], schemas, new ManualClock(), new ProviderClient(path, schemas, f.provider.token), f.conversation);
    assert.ok((await loop.turn({ text: 'socket equality', attachments: [] }, f.options, new AbortController().signal)).ok);
    const begin = events.find(event => event.type === 'model.begin'); assert.ok(begin); assert.deepEqual(begin.payload['request'], captured);
    assert.equal(captured[0]?.type, 'begin'); assert.equal(captured.at(-1)?.type, 'end');
  } finally { assert.ok((await opened.value.stop()).ok); await f.close(); }
});
