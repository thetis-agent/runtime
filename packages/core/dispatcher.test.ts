/** Exercise the real dispatcher against hostile hook behavior; TE-002–003, TE-012–017, TE-025–026. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher } from './dispatcher.ts';
import { Schemas } from '../../lib/schema/index.ts';
import { ManualClock } from '../../lib/events/index.ts';
import { SpillSink } from '../../lib/spill/index.ts';
import type { Stage } from '../../lib/events/stages.ts';
import type { Context, Envelope, ToolDef, CallRequest } from '../../contracts/turn-events/types.ts';

const schemas = new Schemas(); await schemas.load();
const mode = { readOnly: false, deny: [] };
const definition: ToolDef = { name: 'read_path', description: 'Read', schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } }, readOnly: true, endsTurn: false, source: 'forged' };
const context: Context = { sections: { system: [], skills: [], harness: [], history: [] }, budget: { window: 100, reserve: 10, used: 0 } };
const event: Envelope = { type: 'input', conversation: 'c', turn: 1, iteration: 0, seq: 0, payload: { text: 'original', attachments: [] } };
const call: CallRequest = { id: 'call', name: 'read_path', args: { path: '/space' }, deadlineMs: 50, mode, roots: [], budget: { resultBytes: 32 } };

await test('ADR-0022 iteration appenders cannot target the immutable prefix', () => {
  const stage: Stage = { source: 'bad', context: () => undefined };
  Object.assign(stage, { section: 'system' });
  assert.throws(() => new Dispatcher([stage], schemas, new ManualClock()), /immutable prefix/u);
});

await test('TE-002 actor returns of another event type are refused and recorded', () => {
  const dispatcher = new Dispatcher([{ source: 'bad', context: () => ({ type: 'input', payload: {} }) }], schemas, new ManualClock());
  assert.deepEqual(dispatcher.context(context), context);
  assert.equal(dispatcher.rows[0]?.outcome, 'contract-violation');
});

await test('TE-003 an appender cannot replace or reorder another section', () => {
  const dispatcher = new Dispatcher([{ source: 'bad', context: (_append, view) => { Object.assign(view.sections, { system: [{ role: 'system' }] }); } }], schemas, new ManualClock());
  assert.deepEqual(dispatcher.context(context), context);
  assert.equal(dispatcher.rows[0]?.outcome, 'contract-violation');
});

await test('TE-012 read-only filtering records only read-only offers', async () => {
  const dispatcher = new Dispatcher([{ source: 'files@1', offer: () => Promise.resolve([definition, { ...definition, name: 'write_path', readOnly: false }]) }], schemas, new ManualClock());
  assert.deepEqual((await dispatcher.offer({ mode: { readOnly: true, deny: [] } })).map(tool => tool.name), ['read_path']);
});

await test('TE-013 unknown tool calls never invoke a handler', async () => {
  let called = false;
  const dispatcher = new Dispatcher([{ source: 'files@1', call: () => { called = true; return Promise.resolve({ id: 'call', ok: true }); } }], schemas, new ManualClock());
  const result = await dispatcher.call(call, new SpillSink('/tmp', 'unused'));
  assert.equal(result.error?.code, 'not-offered'); assert.equal(called, false);
});

await test('TE-014 arguments are checked against the recorded offer before dispatch', async () => {
  let called = false;
  const stage: Stage = { source: 'files@1', offer: () => Promise.resolve([definition]), call: () => { called = true; return Promise.resolve({ id: 'call', ok: true }); } };
  const dispatcher = new Dispatcher([stage], schemas, new ManualClock());
  await dispatcher.offer({ mode });
  const result = await dispatcher.call({ ...call, args: { path: 3 } }, new SpillSink('/tmp', 'unused'));
  assert.equal(result.error?.code, 'invalid-args'); assert.equal(called, false);
});

await test('TE-017 derived readOnly is ignored unless the environment trusts the source', async () => {
  const stage = { source: 'remote@1', offer: () => Promise.resolve([{ ...definition, derived: true, trusted: true }]) };
  const dispatcher = new Dispatcher([stage], schemas, new ManualClock());
  assert.deepEqual(await dispatcher.offer({ mode: { readOnly: true, deny: [] } }), []);
  assert.equal(dispatcher.rows[0]?.outcome, 'derived-untrusted');
  const trusted = new Dispatcher([stage], schemas, new ManualClock(), new Set(['remote@1']));
  assert.equal((await trusted.offer({ mode: { readOnly: true, deny: [] } })).length, 1);
});

await test('TE-025 throwing observers leave the event available to later observers', () => {
  let observed: Envelope | undefined;
  const dispatcher = new Dispatcher([
    { source: 'bad', observe: () => { throw new Error('fault'); } },
    { source: 'good', observe: value => { observed = value; } }
  ], schemas, new ManualClock());
  dispatcher.observe(event); assert.deepEqual(observed, event);
  assert.equal(dispatcher.rows[0]?.outcome, 'observer-throw');
});

await test('TE-026 observer mutation cannot change a later observer’s payload', () => {
  let observed: Envelope | undefined;
  const dispatcher = new Dispatcher([
    { source: 'bad', observe: value => { Object.assign(value.payload, { text: 'mutated' }); } },
    { source: 'good', observe: value => { observed = value; } }
  ], schemas, new ManualClock());
  dispatcher.observe(event); assert.deepEqual(observed, event);
});

await test('TE-032 a gateway cannot install an own call hook', () => {
  assert.throws(() => new Dispatcher([{ source: 'surface', gateway: true, call: () => Promise.resolve({}) }], schemas, new ManualClock()), /gateway/u);
});

await test('Calls use the recorded offer owner and overwrite a forged source', async () => {
  const stage: Stage = { source: 'files@1', offer: () => Promise.resolve([definition]), call: value => Promise.resolve({ id: value.id, ok: true, content: [{ type: 'text', text: 'owner' }] }) };
  const dispatcher = new Dispatcher([stage], schemas, new ManualClock());
  assert.equal((await dispatcher.offer({ mode }))[0]?.source, 'files@1');
  assert.equal((await dispatcher.call({ ...call, source: 'forged' }, new SpillSink('/tmp', 'unused'))).ok, true);
});

await test('Call policy is checked again against the recorded owner when denials change', async () => {
  let called = false;
  const dispatcher = new Dispatcher([{ source: 'files@1', offer: () => Promise.resolve([definition]), call: () => { called = true; return Promise.resolve({ id: 'call', ok: true }); } }], schemas, new ManualClock());
  await dispatcher.offer({ mode });
  const result = await dispatcher.call({ ...call, mode: { readOnly: false, deny: ['files/read_path'] } }, new SpillSink('/tmp', 'unused'));
  assert.equal(result.error?.code, 'read-only-mode'); assert.equal(called, false);
});

await test('Async context failures are observed and their additions never persist', async () => {
  const dispatcher = new Dispatcher([{ source: 'bad', async context(append) {
    await Promise.resolve(); append({ role: 'system', source: 'bad', content: [{ type: 'text', text: 'late' }] });
    throw new Error('late rejection');
  } }], schemas, new ManualClock());
  const result = dispatcher.context(context);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(result, context); assert.ok(dispatcher.rows.every(row => row.outcome === 'contract-violation'));
});
