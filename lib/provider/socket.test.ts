/** Exercise the actual provider socket with the scripted provider and real identity; PR-001–003. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Result } from '../schema/index.ts';
import type { Provider } from './index.ts';
import { listen } from './server.ts';
import { ProviderClient } from './client.ts';
import { Schemas } from '../schema/index.ts';
import { providerFixture, request, stream, collect } from '../../test/provider-fixture.ts';

async function fixture() {
  const root = await mkdtemp('/tmp/provider-socket-'); const path = join(root, 'service.sock');
  const schemas = new Schemas(); await schemas.load();
  const provider = providerFixture([[{ type: 'delta.text', text: 'first' }, { type: 'delta.text', text: 'second' }]]);
  const outcomes: Result<void>[] = [];
  const opened = await listen(path, provider.provider, schemas, outcome => { outcomes.push(outcome); }); assert.ok(opened.ok);
  const client = new ProviderClient(path, schemas, provider.token);
  return { ...provider, client, outcomes, async close() {
    await new Promise<void>((resolve, reject) => { opened.value.close(error => { if (error) reject(error); else resolve(); }); });
    await rm(root, { recursive: true, force: true });
  } };
}

await test('PR-001 the provider socket describes model capabilities', async () => {
  const f = await fixture();
  try { const result = await f.client.describe(); assert.ok(result.ok); assert.equal(result.value.models[0]?.id, 'scripted'); }
  finally { await f.close(); }
});

await test('PR-003 the provider socket delivers nonnegative usage before stop', async () => {
  const f = await fixture();
  try {
    const events = await collect(f.client.run(stream(request()), f.token, new AbortController().signal));
    assert.deepEqual(events.filter(event => event.type === 'delta.text').map(event => event.text), ['first', 'second']);
    assert.equal(events.at(-1)?.type, 'stop'); assert.equal(f.reports.length, 1);
    const usage = events.find(event => event.type === 'usage'); assert.ok(usage); assert.ok(usage.counters.cost >= 0);
    assert.ok(events.indexOf(usage) < events.findIndex(event => event.type === 'stop'));
    assert.equal(JSON.stringify(f.provider.capturedPrefixes).includes(f.token), false);
  } finally { await f.close(); }
});

await test('Cancellation before a request completes performs no vendor call', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController(); controller.abort();
    const events = await collect(f.client.run(stream(request()), f.token, controller.signal));
    assert.deepEqual(events.at(-1), { type: 'stop', reason: 'cancel' }); assert.equal(f.provider.vendorCalls, 0);
  } finally { await f.close(); }
});

await test('Provider socket rejects an invalid run credential before reaching the vendor', async () => {
  const f = await fixture();
  try {
    const events = await collect(f.client.run(stream(request()), 'invalid', new AbortController().signal));
    assert.ok(events.some(event => event.type === 'error' && event.code === 'auth')); assert.equal(f.provider.vendorCalls, 0);
  } finally { await f.close(); }
});

await test('PR-002 socket requests preserve cached prefix bytes across connections', async () => {
  const f = await fixture();
  try {
    for (let turn = 0; turn < 2; turn++) await collect(f.client.run(stream(request('fixed prefix')), f.token, new AbortController().signal));
    assert.equal(f.provider.capturedPrefixes[0], f.provider.capturedPrefixes[1]);
    assert.equal(f.reports.length, 2);
  } finally { await f.close(); }
});

await test('PR-004 a mid-stream control cancellation produces a terminal cancel', async () => {
  const root = await mkdtemp('/tmp/provider-cancel-'); const path = join(root, 'service.sock');
  const schemas = new Schemas(); await schemas.load();
  const provider: Provider = {
    describe: () => Promise.resolve({ ok: true, value: { models: [] } }),
    async *run(requests, _token, signal) {
      for await (const event of requests) { if (event.type === 'end') break; }
      yield { type: 'start', id: 'call', model: 'scripted' };
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => { resolve(); }, { once: true }); });
      yield { type: 'usage', counters: { cost: 0 } }; yield { type: 'stop', reason: 'cancel' };
    }
  };
  const outcomes: Result<void>[] = [];
  const opened = await listen(path, provider, schemas, outcome => { outcomes.push(outcome); }); assert.ok(opened.ok);
  try {
    const controller = new AbortController(); const client = new ProviderClient(path, schemas, 'test-run');
    const events = [];
    for await (const event of client.run(stream(request()), 'test-run', controller.signal)) {
      events.push(event); if (event.type === 'start') controller.abort();
    }
    assert.deepEqual(events.at(-1), { type: 'stop', reason: 'cancel' });
    assert.equal(events.filter(event => event.type === 'stop').length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => { opened.value.close(error => { if (error) reject(error); else resolve(); }); });
    await rm(root, { recursive: true, force: true });
  }
});
