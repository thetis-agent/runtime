/** Pin negotiation, validation and deadlines against a real socket; KS-002, KS-021. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Peer } from './index.ts';
import type { Handler } from './index.ts';
import type { Method } from '../../contracts/kernel-socket/types.ts';
import { Schemas } from '../schema/index.ts';
import { ManualClock } from '../events/index.ts';
import { socketPair } from '../../test/socket-pair.ts';

async function fixture(handlers: ReadonlyMap<Method, Handler>, clientMethods: readonly string[] = ['health.probe']) {
  const pair = await socketPair(); const schemas = new Schemas(); await schemas.load(); const clock = new ManualClock();
  const callbacks = { note: () => Promise.resolve({ ok: true as const, value: undefined }) };
  const client = new Peer(pair.client, schemas, clock, clientMethods, { ...callbacks, handlers: new Map() });
  const server = new Peer(pair.peer, schemas, clock, [...handlers.keys()], { ...callbacks, handlers });
  const accepted = server.accept({ person: 'alice', scope: 'person', generation: 1 });
  const connected = await client.connect(); assert.ok(connected.ok); assert.ok((await accepted).ok);
  return { client, server, clock, async close() { client.close(); server.close(); await Promise.all([client.finished(), server.finished()]); await pair.close(); } };
}

await test('KS-002 only negotiated methods reach the handler', async () => {
  let calls = 0;
  const f = await fixture(new Map([['health.probe', () => { calls++; return Promise.resolve({ ok: true, value: { ready: true } }); }]]));
  try {
    assert.deepEqual(await f.client.call('health.probe', {}), { ok: true, value: { ready: true } });
    const refused = await f.client.call('profile.get', {}); assert.ok(!refused.ok); assert.equal(refused.error.code, 'unsupported'); assert.equal(calls, 1);
  } finally { await f.close(); }
});

await test('KS-021 valid unknown request fields survive entry validation', async () => {
  const f = await fixture(new Map([['health.probe', params => Promise.resolve({ ok: true, value: params })]]));
  try { assert.deepEqual(await f.client.call('health.probe', { future: { revision: 2 } }), { ok: true, value: { future: { revision: 2 } } }); }
  finally { await f.close(); }
});

await test('Socket method parameters are validated before dispatch', async () => {
  let calls = 0;
  const f = await fixture(new Map([['session.cancel', () => { calls++; return Promise.resolve({ ok: true, value: null }); }]]), ['session.cancel']);
  try {
    const result = await f.client.call('session.cancel', {}); assert.ok(!result.ok); assert.equal(result.error.code, 'invalid-args'); assert.equal(calls, 0);
  } finally { await f.close(); }
});

await test('Socket request deadlines release the request pool without awaiting a handler', async () => {
  const started = Promise.withResolvers<undefined>(); const held = Promise.withResolvers<{ ok: true; value: null }>();
  const f = await fixture(new Map([['health.probe', () => { started.resolve(undefined); return held.promise; }]]));
  try {
    const request = f.client.call('health.probe', {}, 10); await started.promise; f.clock.advance(10);
    const result = await request; assert.ok(!result.ok); assert.equal(result.error.code, 'deadline');
  } finally { held.resolve({ ok: true, value: null }); await f.close(); }
});
