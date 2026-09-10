/** Assert timer/byte batching and bounded subscriber replay with an injected clock; ADR 0015 §9. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../events/index.ts';
import { SessionEvents } from './index.ts';
import { Batches, limits } from './batch.ts';
import type { Envelope } from '../../contracts/turn-events/types.ts';

function event(type: 'token' | 'end', seq: number): Envelope {
  return { type, conversation: 'conversation', turn: 1, iteration: type === 'end' ? 0 : 1, seq, payload: type === 'token' ? { text: 'x' } : { reason: 'answer', iterations: 1, compactions: 0 } };
}

await test('KS-020 session batches wait fifty milliseconds, flush on end and coalesce burst tokens', async () => {
  const clock = new ManualClock(); const rows: Record<string, unknown>[] = [];
  const batches = new Batches(clock, value => { rows.push(value); return Promise.resolve({ ok: true, value: undefined }); }, result => { assert.ok(result.ok); });
  batches.push({ cursor: 1, event: event('token', 0), bytes: 100 }); assert.equal(rows.length, 0);
  clock.advance(49); await Promise.resolve(); assert.equal(rows.length, 0);
  clock.advance(1); await Promise.resolve(); assert.equal(rows.length, 1); await Promise.resolve();
  for (let index = 2; index <= 1001; index++) batches.push({ cursor: index, event: event('token', index), bytes: 100 });
  batches.push({ cursor: 1002, event: event('end', 1002), bytes: 100 });
  for (let step = 0; step < 100; step++) await Promise.resolve();
  assert.ok(rows.length < 40); assert.equal(rows.at(-1)?.['cursor'], 1002); batches.close();
});

await test('Session replay is cursor-bound and a slow subscriber cannot grow its queue without limit', async () => {
  const clock = new ManualClock(); const hub = new SessionEvents(clock); const rows: Record<string, unknown>[] = [];
  const first = hub.subscribe('conversation', undefined, value => { rows.push(value); return Promise.resolve({ ok: true, value: undefined }); }, result => { assert.ok(result.ok); }); assert.ok(first.ok);
  hub.observe(event('token', 1)); hub.observe(event('end', 2)); await Promise.resolve(); first.value.close();
  const replay = hub.subscribe('conversation', 0, value => { rows.push(value); return Promise.resolve({ ok: true, value: undefined }); }, result => { assert.ok(result.ok); }); assert.ok(replay.ok);
  assert.equal(replay.value.result.cursor, 2); assert.ok(!hub.subscribe('conversation', 99, () => Promise.resolve({ ok: true, value: undefined }), () => {}).ok); replay.value.close();
  let refused = false; const sending = Promise.withResolvers<{ ok: true; value: undefined }>();
  const slow = new Batches(clock, () => sending.promise, result => { assert.ok(!result.ok); refused = true; });
  for (let index = 0; index < 4; index++) slow.push({ cursor: index, event: event('token', index), bytes: limits.eventBytes });
  assert.equal(refused, true); sending.resolve({ ok: true, value: undefined }); await Promise.resolve();
});
