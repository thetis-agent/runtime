/** Keep the admitted envelope set, the committed stream schema and the contract in step; ADR 0019, KS-004. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ManualClock } from '@/lib/events/index.ts';
import { Schemas, isObject } from '@/lib/schema/index.ts';
import type { Validator } from '@/lib/schema/index.ts';
import { SessionEvents, observed, admits } from './index.ts';
import { limits } from './batch.ts';
import type { Event } from './types.ts';
import type { Envelope } from '@/contracts/turn-events/types.ts';

async function document(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
  if (!isObject(value)) throw new Error(`The committed schema is invalid: ${path}`);
  return value;
}

/** The oneOf branches are `{ properties: { type: { const } } }`, so the named set is readable
 * from the committed document itself rather than restated by a test that could drift with it. */
async function named(): Promise<string[]> {
  const schema = await document('./schema.json');
  const event = schema['$defs'];
  if (!isObject(event) || !isObject(event['event'])) throw new Error('The session event definition is absent.');
  const all = event['event']['allOf'];
  if (!Array.isArray(all) || !isObject(all[1]) || !Array.isArray(all[1]['oneOf'])) throw new Error('The session event union is absent.');
  return all[1]['oneOf'].map((branch: unknown) => {
    const properties = isObject(branch) ? branch['properties'] : undefined;
    const type = isObject(properties) ? properties['type'] : undefined;
    const value = isObject(type) ? type['const'] : undefined;
    if (typeof value !== 'string') throw new Error('A session event branch names no type.');
    return value;
  });
}

async function envelopeTypes(): Promise<string[]> {
  const contract = await document('../../contracts/turn-events/schema.json');
  const defs = contract['$defs'];
  if (!isObject(defs) || !isObject(defs['envelope'])) throw new Error('The turn-events envelope is absent.');
  const properties = defs['envelope']['properties'];
  const type = isObject(properties) ? properties['type'] : undefined;
  const values = isObject(type) ? type['enum'] : undefined;
  if (!Array.isArray(values)) throw new Error('The turn-events envelope names no types.');
  return values.map(value => { if (typeof value !== 'string') throw new Error('A turn-events type is not a string.'); return value; });
}

function payloads(): Record<string, Record<string, unknown>> {
  return {
    input: { text: 'hello', attachments: [] },
    retrieve: { entries: [], dropped: [] },
    context: { sections: { system: [], skills: [], harness: [], history: [] }, budget: { window: 1000, reserve: 100, used: 10 } },
    offer: { tools: [], mode: { readOnly: false, deny: [] } },
    'model.begin': { provider: 'vendor', model: 'model', request: [] },
    'model.event': { event: { type: 'delta.reasoning', text: 'thinking' } },
    'model.end': { stop: 'answer', usage: { cost: 0 } },
    call: { id: 'call', name: 'read', args: {}, deadlineMs: 1000, mode: { readOnly: true, deny: [] }, roots: [], budget: { resultBytes: 1024 } },
    token: { text: 'x' },
    output: { message: { role: 'assistant', source: 'core', content: [] }, usage: { cost: 0 } },
    end: { reason: 'answer', iterations: 1, compactions: 0 },
    notice: { source: 'package', content: [] }
  };
}

function envelope(type: string, seq: number, payload: Record<string, unknown>): Envelope {
  return { type: envelopeType(type), conversation: 'conversation', turn: 1, iteration: 0, seq, payload };
}

/** Narrow the fixture's string to the generated union without a cast, so a type the contract
 * drops fails the type check here rather than reaching a subscriber at run time. */
function envelopeType(type: string): Envelope['type'] {
  const all: Envelope['type'][] = ['input', 'retrieve', 'context', 'offer', 'model.begin', 'model.event', 'model.end', 'call', 'token', 'output', 'end', 'notice'];
  const found = all.find(candidate => candidate === type);
  if (!found) throw new Error(`The turn-events contract does not name ${type}.`);
  return found;
}

await test('The session stream names every turn-events envelope type exactly once', async () => {
  const branches = await named();
  assert.equal(new Set(branches).size, branches.length, 'a session event type is named twice');
  assert.deepEqual([...branches].sort(), [...await envelopeTypes()].sort());
  assert.deepEqual([...observed].sort(), [...branches].sort(), 'the observe filter and the committed schema disagree');
});

await test('Every named envelope type validates against the committed stream schema', async () => {
  const schemas = new Schemas(); await schemas.load();
  const check: Validator<Event> = schemas.definition<Event>(await document('./schema.json'), 'event');
  let seq = 0;
  for (const [type, payload] of Object.entries(payloads())) assert.ok(check(envelope(type, seq++, payload)), `${type} is refused by the stream schema`);
  assert.ok(check(envelope('call', seq++, { id: 'call', ok: true, content: [] })), 'a call answer is refused by the stream schema');
  assert.ok(!check({ type: 'token', conversation: 'conversation', turn: 1, iteration: 0, seq: 0, payload: { text: 1 } }), 'a malformed token payload is accepted');
  assert.ok(!check({ type: 'unnamed', conversation: 'conversation', turn: 1, iteration: 0, seq: 0, payload: {} }), 'an unnamed type is accepted');
});

await test('A widened stream delivers and replays every named type, and refuses one it does not name', async () => {
  const clock = new ManualClock(); const hub = new SessionEvents(clock); const batches: Record<string, unknown>[] = [];
  const send = (value: Record<string, unknown>): Promise<{ ok: true; value: undefined }> => { batches.push(value); return Promise.resolve({ ok: true, value: undefined }); };
  const live = hub.subscribe('conversation', undefined, send, result => { assert.ok(result.ok); }); assert.ok(live.ok);
  const entries = Object.entries(payloads()); let seq = 0;
  for (const [type, payload] of entries) hub.observe(envelope(type, seq++, payload));
  for (let step = 0; step < 20; step++) { clock.advance(limits.batchMs); await Promise.resolve(); }
  const delivered = batches.flatMap(batch => {
    const events = batch['events'];
    return Array.isArray(events) ? events.map((event: unknown) => (isObject(event) ? event['type'] : undefined)) : [];
  });
  assert.deepEqual([...new Set(delivered)].sort(), entries.map(([type]) => type).sort());
  live.value.close();
  const replay = hub.subscribe('conversation', 0, send, result => { assert.ok(result.ok); }); assert.ok(replay.ok);
  assert.equal(replay.value.result.cursor, entries.length, 'every named type took a cursor');
  replay.value.close();
  assert.equal(admits('unnamed'), false); assert.equal(admits('model.begin'), true); assert.equal(admits(''), false);
});

/** Widening admits `context` and `offer`, whose payloads carry the rendered prefix and the whole
 * tool table, so a single frame can now be far larger than a token. batch.ts refuses a subscriber
 * outright once one event exceeds eventBytes; this pins that behaviour so the budget decision is
 * visible rather than discovered as a disconnect (ADR 0015 §9). */
await test('An event above the named event budget refuses its subscriber instead of truncating it', () => {
  const clock = new ManualClock(); const hub = new SessionEvents(clock); let refused: string | undefined;
  const live = hub.subscribe('conversation', undefined, () => Promise.resolve({ ok: true, value: undefined }), result => { if (!result.ok) refused = result.error.code; });
  assert.ok(live.ok);
  hub.observe(envelope('context', 0, { sections: { system: [{ role: 'system', source: 'core', content: [{ type: 'text', text: 'x'.repeat(limits.eventBytes) }] }], skills: [], harness: [], history: [] }, budget: { window: 1, reserve: 0, used: 0 } }));
  assert.equal(refused, 'budget');
  live.value.close();
});

/* The `cursor-replay` half of KS-004: a subscriber that lost its connection names the last event it
 * drew and gets exactly what came after it, and one that names a position outside the retained window
 * is refused with a code the gateway can act on rather than one it has to guess at. */
function observeAll(hub: SessionEvents, types: readonly string[]): void {
  const shapes = payloads(); let seq = 0;
  for (const type of types) { const payload = shapes[type]; assert.ok(payload); hub.observe(envelope(type, seq++, payload)); }
}

async function drain(clock: ManualClock): Promise<void> {
  for (let step = 0; step < 20; step++) { clock.advance(limits.batchMs); await Promise.resolve(); }
}

await test('A subscription from a position replays only what came after it', async () => {
  const clock = new ManualClock(); const hub = new SessionEvents(clock); const batches: Record<string, unknown>[] = [];
  const send = (value: Record<string, unknown>): Promise<{ ok: true; value: undefined }> => { batches.push(value); return Promise.resolve({ ok: true, value: undefined }); };
  const seed = hub.subscribe('conversation', undefined, () => Promise.resolve({ ok: true, value: undefined }), result => { assert.ok(result.ok); }); assert.ok(seed.ok);
  observeAll(hub, ['input', 'token', 'token', 'model.end', 'end']);
  seed.value.close();
  const resumed = hub.subscribe('conversation', 2, send, result => { assert.ok(result.ok); }); assert.ok(resumed.ok);
  assert.equal(resumed.value.result.cursor, 5); assert.equal(resumed.value.result.oldest, 1);
  await drain(clock);
  const replayed = batches.flatMap(value => { const events = value['events']; return Array.isArray(events) ? events.map((event: unknown) => (isObject(event) ? event['type'] : undefined)) : []; });
  assert.deepEqual(replayed, ['token', 'model.end', 'end'], 'a resume must deliver every event after the named position and none before it');
  assert.equal(batches.at(-1)?.['cursor'], 5, 'the replayed batch still counts from the conversation, so the next resume can continue from it');
  resumed.value.close();
});

await test('A position the stream can no longer reach is refused as not-found rather than silently restarted', () => {
  const clock = new ManualClock(); const hub = new SessionEvents(clock);
  const seed = hub.subscribe('conversation', undefined, () => Promise.resolve({ ok: true, value: undefined }), result => { assert.ok(result.ok); }); assert.ok(seed.ok);
  observeAll(hub, ['input', 'token', 'end']);
  seed.value.close();
  const ahead = hub.subscribe('conversation', 9, () => Promise.resolve({ ok: true, value: undefined }), result => { assert.ok(result.ok); });
  assert.ok(!ahead.ok); assert.equal(ahead.error.code, 'not-found');
  const behind = hub.subscribe('other', 4, () => Promise.resolve({ ok: true, value: undefined }), result => { assert.ok(result.ok); });
  assert.ok(!behind.ok); assert.equal(behind.error.code, 'not-found');
  const zero = hub.subscribe('conversation', 0, () => Promise.resolve({ ok: true, value: undefined }), result => { assert.ok(result.ok); });
  assert.ok(zero.ok, 'the position before the oldest retained event is inside the window, not outside it');
  zero.value.close();
});
