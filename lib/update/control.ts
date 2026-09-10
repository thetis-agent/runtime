/** Reach the supervisor only over its owner-only control socket, one bounded command per connection; ADR 0048. */
import { randomUUID } from 'node:crypto';
import { connect, socketFrames, send } from '@/lib/ndjson/socket.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';

export const controlLimits = { deadlineMs: 900000 };
export interface View { state: string; current: { n: number; pins: Readonly<Record<string, string>> } }
export interface Report { view: View; release: string; previous: string | null; endpoint: string; state: string }

export async function ask(path: string, method: 'status' | 'update' | 'undo' | 'stop', extra: Readonly<Record<string, unknown>> = {}): Promise<Result<unknown>> {
  const socket = await connect(path);
  if (!socket.ok) return failure('io', 'The supervisor control socket is not accepting connections.');
  socket.value.setTimeout(controlLimits.deadlineMs, () => { socket.value.destroy(); });
  try {
    const sent = await send(socket.value, { id: randomUUID(), method, ...extra }); if (!sent.ok) return sent;
    const frame = await socketFrames(socket.value).next();
    if (frame.done || !frame.value.ok || !isObject(frame.value.value)) return failure('io', 'The supervisor answered nothing usable.');
    const reply = frame.value.value;
    if (reply['ok'] === true) return { ok: true, value: reply['value'] };
    const error = reply['error'];
    return isObject(error) && typeof error['message'] === 'string' ? failure('unsupported', error['message']) : failure('io', 'The supervisor refused without a reason.');
  } finally { socket.value.destroy(); }
}

export async function report(path: string): Promise<Result<Report>> {
  const answered = await ask(path, 'status'); if (!answered.ok) return answered;
  const value = answered.value;
  if (!isObject(value) || !isObject(value['view'])) return failure('io', 'The supervisor answered an unusable generation view.');
  const view = value['view']; const current: unknown = view['current'];
  if (typeof view['state'] !== 'string' || !isObject(current) || typeof current['n'] !== 'number' || !isObject(current['pins'])) return failure('io', 'The supervisor answered an unusable generation view.');
  const pins: Record<string, string> = {};
  for (const [name, hash] of Object.entries(current['pins'])) if (typeof hash === 'string') pins[name] = hash;
  const strings = ['release', 'endpoint', 'state'].map(key => value[key]);
  if (!strings.every((item): item is string => typeof item === 'string')) return failure('io', 'The supervisor answered without its release paths.');
  const [release = '', endpoint = '', state = ''] = strings;
  return { ok: true, value: { view: { state: view['state'], current: { n: current['n'], pins } }, release, previous: typeof value['previous'] === 'string' ? value['previous'] : null, endpoint, state } };
}
