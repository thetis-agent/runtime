/** Pin admission and drain deadlines using real sockets and an injected clock; PR-001, PR-004. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { ManualClock } from '../events/index.ts';
import { Schemas } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';
import { connect, send } from '../ndjson/socket.ts';
import { listen } from './server.ts';
import { serviceLimits } from './lifecycle.ts';
import { ProviderEngine } from './engine.ts';
import type { Vendor } from './engine.ts';
import { ProviderClient } from './client.ts';
import { providerFixture, request, stream, collect } from '../../test/provider-fixture.ts';

const closure = (socket: Socket): Promise<void> => new Promise(resolve => { socket.once('close', () => { resolve(); }); });

async function fixture(vendor?: Vendor) {
  const root = await mkdtemp('/tmp/provider-lifetime-');
  const schemas = new Schemas(); await schemas.load(); const clock = new ManualClock();
  const provider = providerFixture(); const outcomes: Result<void>[] = [];
  const observed = Promise.withResolvers<undefined>();
  const path = join(root, 'service.sock');
  const adapter = vendor ? new ProviderEngine(vendor, provider.authority, provider.budgets) : provider.provider;
  const opened = await listen(path, adapter, schemas, outcome => { outcomes.push(outcome); observed.resolve(undefined); }, clock, { ...serviceLimits, connections: 1 }); assert.ok(opened.ok);
  return { ...provider, path, clock, outcomes, observed: observed.promise, service: opened.value, client: new ProviderClient(path, schemas, provider.token),
    async close() { await opened.value.stop(); await rm(root, { recursive: true, force: true }); }
  };
}

await test('PR-001 incomplete provider preludes expire without vendor access', async () => {
  for (const prelude of [false, true]) {
    const f = await fixture();
    try {
      const opened = await connect(f.path); assert.ok(opened.ok);
      if (prelude) assert.ok((await send(opened.value, { v: '1', runToken: f.token })).ok);
      const closed = closure(opened.value);
      f.clock.advance(serviceLimits.probeMs); await closed; await f.observed;
      assert.equal(f.provider.vendorCalls, 0);
      assert.deepEqual(f.outcomes.map(result => result.ok ? 'ok' : result.error.code), ['deadline']);
    } finally { await f.close(); }
  }
});

await test('PR-004 complete requests retain their exchange budget and abort the vendor at its deadline', async () => {
  const entered = Promise.withResolvers<undefined>(); let cancelled = false;
  const vendor: Vendor = {
    describe: () => Promise.resolve({ ok: true, value: { models: [] } }), estimate: () => 0.01,
    async *exchange(_request, signal) {
      signal.addEventListener('abort', () => { cancelled = true; }, { once: true });
      entered.resolve(undefined);
      yield { type: 'start', id: 'call', model: 'scripted' };
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => { resolve(); }, { once: true }); });
      yield { type: 'stop', reason: 'cancel' };
    }
  };
  const f = await fixture(vendor);
  try {
    const response = collect(f.client.run(stream(request()), f.token, new AbortController().signal));
    await entered.promise;
    f.clock.advance(serviceLimits.probeMs); assert.equal(f.service.connections, 1); assert.equal(cancelled, false);
    f.clock.advance(serviceLimits.exchangeMs - serviceLimits.probeMs);
    const events = await response; await f.observed;
    assert.equal(cancelled, true); assert.equal(events.at(-1)?.type, 'error');
    assert.deepEqual(f.outcomes.map(result => result.ok ? 'ok' : result.error.code), ['deadline']);
  } finally { await f.close(); }
});

await test('PR-001 an incomplete begin shares the admission deadline and cannot hold the connection pool', async () => {
  const f = await fixture();
  try {
    const first = await connect(f.path); assert.ok(first.ok);
    assert.ok((await send(first.value, { v: '1', runToken: f.token })).ok);
    assert.ok((await send(first.value, request()[0])).ok);
    const second = await connect(f.path); assert.ok(second.ok);
    await closure(second.value); assert.equal(f.service.connections, 1);
    const closed = closure(first.value); f.clock.advance(serviceLimits.probeMs);
    await closed; await f.observed;
    assert.equal(f.provider.vendorCalls, 0);
    assert.equal(f.outcomes[0]?.ok, false);
  } finally { await f.close(); }
});

await test('PR-004 draining closes admission and force-closes incomplete sockets at the deadline', async () => {
  const f = await fixture();
  try {
    const opened = await connect(f.path); assert.ok(opened.ok);
    const closed = closure(opened.value);
    const stopped = f.service.stop(); assert.equal(f.service.ready, false);
    assert.equal(f.service.stop(), stopped);
    f.clock.advance(serviceLimits.drainMs);
    const result = await stopped; assert.ok(!result.ok); assert.equal(result.error.code, 'deadline');
    await closed; await f.observed; assert.equal(f.provider.vendorCalls, 0);
    assert.equal((await connect(f.path)).ok, false);
  } finally { await f.close(); }
});
