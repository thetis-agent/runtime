/** Keep a fatal inherited frame visible as an end diagnostic on the private stream; TE-031. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { providerFixture } from '@/test/provider-fixture.ts';
import { faultProcess } from '@/test/fault-process.ts';
import { ProviderEngine } from '@/lib/provider/engine.ts';
import type { Vendor } from '@/lib/provider/engine.ts';
import { listen } from '@/lib/provider/server.ts';
import { SessionClient } from '@/lib/session/client.ts';
import { Schemas, isObject } from '@/lib/schema/index.ts';
import { ManualClock } from '@/lib/events/index.ts';
import type { Batch } from '@/lib/session/types.ts';

await test('TE-031 an oversized inherited frame ends the active turn as crash with frame-too-large', async () => {
  const root = await mkdtemp('/tmp/fault-vendor-'); const schemas = new Schemas(); await schemas.load(); const fixture = providerFixture();
  const entered = Promise.withResolvers<undefined>();
  const vendor: Vendor = { describe: () => fixture.provider.describe(), estimate: () => 0.01, async *exchange(_request, signal) {
    yield { type: 'delta.text', text: 'private' }; entered.resolve(undefined);
    await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => { resolve(); }, { once: true }); });
    yield { type: 'stop', reason: 'cancel' };
  } };
  const service = await listen(join(root, 'provider.sock'), new ProviderEngine(vendor, fixture.authority, fixture.budgets), schemas, () => {}); assert.ok(service.ok);
  const environment = await faultProcess(fixture, join(root, 'provider.sock')); const batches: Batch[] = [];
  const created = await environment.peer.call('session.create', { surface: 'faux' }); assert.ok(created.ok && isObject(created.value)); const id = created.value['id']; assert.ok(typeof id === 'string');
  const client = await SessionClient.open(join(environment.root, 'endpoint/service.sock'), schemas, new ManualClock(), batch => { batches.push(batch); return Promise.resolve({ ok: true, value: undefined }); }); assert.ok(client.ok);
  try {
    assert.ok((await client.value.subscribe(id)).ok);
    const turn = environment.peer.call('session.submit', { conversation: id, input: { text: 'Hello', attachments: [] } }); await entered.promise;
    environment.raw.write(Buffer.alloc(1048577, 32));
    assert.ok((await client.value.end()).ok); assert.ok(!(await turn).ok);
    const end = batches.flatMap(batch => batch.events).find(event => event.type === 'end'); assert.ok(end && isObject(end.payload));
    assert.equal(end.payload['reason'], 'crash'); assert.equal(end.payload['code'], 'frame-too-large');
    const exit = await environment.running.exited; assert.equal(exit.code, 1);
  } finally { client.value.close(); await environment.close(); assert.ok((await service.value.stop()).ok); await rm(root, { recursive: true, force: true }); }
});
