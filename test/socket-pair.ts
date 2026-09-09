/** Exercise real local transports without relying on ports or external services; KS-021. */
import assert from 'node:assert/strict';
import { socketPair as open } from '../lib/socket/pair.ts';

export async function socketPair() {
  const result = await open(); assert.ok(result.ok, JSON.stringify(result));
  return { client: result.value.client, peer: result.value.peer, async close() { assert.ok((await result.value.close()).ok); } };
}
