/** Validate one bounded registration description from the sandboxed worker service; TE-021, ADR 0027. */
import { connect, send, socketFrames } from '../ndjson/socket.ts';
import { validator } from './index.ts';
import { failure } from '../schema/index.ts';
import type { Result, Schemas } from '../schema/index.ts';
import type { Captured, DiscoveryResponse } from './types.ts';
import { clock } from '../events/index.ts';
import type { Clock } from '../events/index.ts';
const limits = { pending: 8, deadlineMs: 60000 }; let active = 0;
export async function describe(path: string, schemas: Schemas, time: Clock = clock): Promise<Result<Captured>> {
  if (active >= limits.pending) return failure('budget', 'The discovery request pool is full.'); active++;
  const connected = await connect(path); if (!connected.ok) { active--; return failure('io', 'The discovery service could not be reached.'); }
  const controller = new AbortController();
  const timeout = time.wait(limits.deadlineMs, controller.signal).then(() => { if (!controller.signal.aborted) connected.value.destroy(); });
  try {
    const validate = await validator<DiscoveryResponse>(schemas, 'discoveryResponse');
    const written = await send(connected.value, { v: '1', id: 'describe', method: 'describe' }); if (!written.ok) return written;
    const frames = socketFrames(connected.value); const first = await frames.next();
    if (first.done || !first.value.ok || !validate(first.value.value) || first.value.value.id !== 'describe') return failure('io', 'The discovery reply violates its schema or request identity.');
    return first.value.value.ok ? { ok: true, value: first.value.value.value } : { ok: false, error: first.value.value.error };
  } catch { return failure('io', 'The discovery socket closed before a valid response.'); }
  finally { controller.abort(); connected.value.destroy(); await timeout; active--; }
}
