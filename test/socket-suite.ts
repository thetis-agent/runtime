/** Run the negotiated transport intersection unchanged in both directions; KS-002–003, KS-021. */
import assert from 'node:assert/strict';
import type { Peer } from '@/lib/socket/index.ts';

export async function socketSuite(peer: Pick<Peer, 'call'>): Promise<void> {
  assert.deepEqual(await peer.call('health.probe', { future: { value: 2 } }), { ok: true, value: { ready: true, future: { value: 2 } } });
  const missing = await peer.call('profile.get', {}); assert.ok(!missing.ok); assert.equal(missing.error.code, 'unsupported');
  const invalid = await peer.call('session.cancel', {}); assert.ok(!invalid.ok); assert.equal(invalid.error.code, 'invalid-args');
  assert.deepEqual(await peer.call('session.cancel', { conversation: 'one', extension: true }), { ok: true, value: { cancelled: true } });
  assert.ok((await peer.call('health.probe', { fence: true })).ok);
  const fenced = await peer.call('health.probe', {}); assert.ok(!fenced.ok); assert.equal(fenced.error.code, 'fenced');
}
