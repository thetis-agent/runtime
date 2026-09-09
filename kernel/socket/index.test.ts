/** Reject uncredentialled connections and prevent frame extensions from changing identity; KS-001, KS-021. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accept } from './index.ts';
import type { Operations } from './index.ts';
import { Identity } from '../identity/index.ts';
import { Peer } from '../../lib/socket/index.ts';
import { Schemas } from '../../lib/schema/index.ts';
import { ManualClock } from '../../lib/events/index.ts';
import { socketPair } from '../../test/socket-pair.ts';

async function fixture() {
  const pair = await socketPair(); const schemas = new Schemas(); await schemas.load(); const clock = new ManualClock();
  const identity = new Identity({ people: [{ id: 'alice', role: 'user', projects: [], observeOthers: false }], bindings: [], authorities: {} }, () => clock.now());
  const token = identity.issue({ id: 'one', person: 'alice', scope: 'person', target: 'alice', generation: 1, services: [] }); assert.ok(token.ok);
  const operations: Operations = { methods: new Map([['health.probe', run => Promise.resolve({ ok: true, value: run.person })]]), notes: [], note: () => Promise.resolve({ ok: true, value: undefined }) };
  return { pair, schemas, clock, identity, token: token.value, operations };
}

await test('KS-001 a socket without its inherited endpoint credential is refused', async () => {
  const f = await fixture();
  try { const result = await accept(f.pair.peer, '', f.identity, f.schemas, f.clock, f.operations); assert.ok(!result.ok); assert.equal(result.error.code, 'auth'); }
  finally { await f.pair.close(); }
});

await test('KS-021 request extensions cannot change the endpoint principal and a fence takes effect immediately', async () => {
  const f = await fixture();
  const client = new Peer(f.pair.client, f.schemas, f.clock, ['health.probe'], { handlers: new Map(), note: () => Promise.resolve({ ok: true, value: undefined }) });
  const accepting = accept(f.pair.peer, f.token, f.identity, f.schemas, f.clock, f.operations);
  const connected = await client.connect(); const accepted = await accepting; assert.ok(connected.ok); assert.ok(accepted.ok);
  try {
    assert.equal(connected.value.person, 'alice');
    assert.deepEqual(await client.call('health.probe', { person: 'mallory', scope: 'deployment' }), { ok: true, value: 'alice' });
    f.identity.fence('alice', 2);
    const refused = await client.call('health.probe', {}); assert.ok(!refused.ok); assert.equal(refused.error.code, 'fenced');
  } finally { client.close(); accepted.value.close(); await Promise.all([client.finished(), accepted.value.finished()]); await f.pair.close(); }
});
