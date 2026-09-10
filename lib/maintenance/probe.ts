/** Test the candidate's real handshake and health using every currently connected client major; GN-007. */
import { open } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import { connect, socketFrames, send } from '@/lib/ndjson/socket.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Schemas, Result } from '@/lib/schema/index.ts';
import type { Clock } from '@/lib/events/index.ts';
import type { Response } from '@/contracts/kernel-socket/types.ts';
import schema from './schema.json' with { type: 'json' };
import type { Welcome } from './types.ts';

export async function probe(path: string, major: string, schemas: Schemas, clock: Clock): Promise<Result<void>> {
  const directory = await open(dirname(path), 'r');
  const connected = await connect(`/proc/self/fd/${String(directory.fd)}/${basename(path)}`); await directory.close();
  if (!connected.ok) return connected;
  const socket = connected.value; const timer = new AbortController();
  const exchange = async (): Promise<Result<void>> => {
    const rows = socketFrames(socket); const sent = await send(socket, { v: major, capabilities: ['health.probe'] }); if (!sent.ok) return sent;
    const first = await rows.next();
    const welcome = schemas.compile<Welcome>({ ...schema, $id: 'thetis://internal/maintenance/welcome', $ref: '#/$defs/welcome' });
    if (first.done || !first.value.ok || !welcome(first.value.value) || first.value.value.v !== major || !first.value.value.capabilities.includes('health.probe')) return failure('unsupported', `The candidate kernel does not support client major ${major}.`);
    const asked = await send(socket, { id: 'probe', method: 'health.probe', params: {} }); if (!asked.ok) return asked;
    const answer = await rows.next();
    if (answer.done || !answer.value.ok || !schemas.validator<Response>('kernel-socket', 'response')(answer.value.value)) return failure('invalid-args', 'The candidate kernel health response violates its schema.');
    const value = answer.value.value;
    return 'result' in value && isObject(value.result) && value.result['ready'] === true ? { ok: true, value: undefined } : failure('io', 'The candidate kernel did not answer healthy.');
  };
  try { return await Promise.race([exchange(), clock.wait(10000, timer.signal).then(() => failure('deadline', 'The kernel compatibility probe exceeded its deadline.'))]); }
  catch { return failure('io', 'The candidate kernel probe could not be completed.'); }
  finally { timer.abort(); socket.destroy(); }
}
