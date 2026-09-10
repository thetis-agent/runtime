/** Transfer connected descriptors after removing their private listening path; KS-001. */
import type { Socket } from 'node:net';
import { connect } from '@/lib/ndjson/socket.ts';
import { privateEndpoint } from './private.ts';
import type { Result } from '@/lib/schema/index.ts';

export interface Pair { client: Socket; peer: Socket; close(): Promise<Result<void, 'io'>> }

export async function socketPair(root = '/tmp'): Promise<Result<Pair, 'io' | 'budget'>> {
  const endpoint = await privateEndpoint(root); if (!endpoint.ok) return endpoint;
  const connected = await connect(endpoint.value.path);
  if (!connected.ok) { const stopped = await endpoint.value.close(); return stopped.ok ? { ok: false, error: { code: 'io', message: connected.error.message } } : stopped; }
  const accepted = await endpoint.value.accepted;
  if (!accepted.ok) { connected.value.destroy(); const stopped = await endpoint.value.close(); return stopped.ok ? accepted : stopped; }
  return { ok: true, value: { client: connected.value, peer: accepted.value, close: () => { connected.value.destroy(); return endpoint.value.close(); } } };
}
