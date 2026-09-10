/** Bound one registry exchange and validate the service reply once; ADR 0006, ADR 0007. */
import { readFile } from 'node:fs/promises';
import { connect, send, socketFrames } from '@/lib/ndjson/socket.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Schemas, Result } from '@/lib/schema/index.ts';
import { clock } from '@/lib/events/index.ts';
import type { Clock } from '@/lib/events/index.ts';
import type { Request, Response } from './types.ts';
let active = 0;
export const clientLimits = { exchanges: 32, deadlineMs: 30000 };
export async function call(path: string, request: Request, schemas: Schemas, time: Clock = clock, deadlineMs = clientLimits.deadlineMs): Promise<Result<unknown>> {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > 600000) return failure('invalid-args', 'The registry deadline exceeds its configured bound.');
  if (active >= clientLimits.exchanges) return failure('budget', 'The registry client pool is full.');
  active++;
  const stop = new AbortController(); const state = { expired: false };
  const opened = await connect(path);
  if (!opened.ok) { active--; return failure('io', 'The registry service could not be reached.'); }
  const deadline = time.wait(deadlineMs, stop.signal).then(() => { if (!stop.signal.aborted) { state.expired = true; opened.value.destroy(); } });
  try {
    const raw: unknown = JSON.parse(await readFile(new URL('../../contracts/registry/schema.json', import.meta.url), 'utf8'));
    if (!isObject(raw)) throw new Error('The committed registry schema is invalid.');
    const validate = schemas.compile<Response>({ ...raw, $id: 'thetis://internal/registry/response', $ref: '#/$defs/response' });
    const written = await send(opened.value, request); if (!written.ok) return failure('io', 'The registry request could not be written.');
    const frames = socketFrames(opened.value); const response = await frames.next();
    if (response.done) return failure('io', 'The registry connection ended before its reply.');
    if (!response.value.ok) return response.value;
    if (!validate(response.value.value) || response.value.value.id !== request.id) return failure('io', 'The registry reply violates its schema or request identity.');
    return response.value.value.ok ? { ok: true, value: response.value.value.value } : { ok: false, error: response.value.value.error };
  } catch { return failure(state.expired ? 'deadline' : 'io', state.expired ? 'The registry request exceeded its deadline.' : 'The registry exchange failed.'); }
  finally { stop.abort(); opened.value.destroy(); await deadline; active--; }
}
