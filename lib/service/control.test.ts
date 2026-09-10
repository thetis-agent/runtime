/** Preserve deferred admission control with real sockets and deterministic drain deadlines; ADR 0010, GN-004. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import { ManualClock } from '@/lib/events/index.ts';
import { connect } from '@/lib/ndjson/socket.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import { Control } from './control.ts';
import { Service, serviceLimits } from './lifecycle.ts';

const success: Result<void> = { ok: true, value: undefined };
const forbidden = failure('forbidden', 'The service does not accept this control note.');

function probe(control: Control): Promise<Result<unknown>> {
  const handler = control.handlers.get('health.probe'); assert.ok(handler);
  return handler({});
}

async function fixture() {
  const root = await mkdtemp('/tmp/service-control-'); const path = join(root, 'service.sock');
  const clock = new ManualClock(); const service = new Service(clock, serviceLimits, 'io');
  const sockets = new Set<Socket>(); const accepted = Promise.withResolvers<undefined>();
  const opened = await service.open(path, connection => new Promise<Result<void>>(resolve => {
    sockets.add(connection.socket);
    connection.socket.once('close', () => { sockets.delete(connection.socket); resolve(success); });
    connection.admitted(); accepted.resolve(undefined);
  }), () => undefined);
  assert.ok(opened.ok);
  return { service, clock, path, accepted: accepted.promise, async close() {
    for (const socket of sockets) socket.destroy();
    await service.stop(); await rm(root, { recursive: true, force: true });
  } };
}

await test('GN-004 an early stop pauses the attached service before health resolves and permits resume', async () => {
  const f = await fixture(); let projections = 0;
  const control = new Control((service, stopping) => {
    projections++;
    return { ready: service?.ready, paused: service?.paused, stopping };
  }, forbidden);
  try {
    const pending = probe(control); await Promise.resolve(); assert.equal(projections, 0);
    assert.ok((await control.note({ note: 'run.stop', params: {} })).ok);
    control.ready(success, f.service);
    assert.equal(f.service.paused, true);
    assert.deepEqual(await pending, { ok: true, value: { ready: true, paused: true, stopping: true } });
    assert.ok((await control.note({ note: 'run.stop', params: {} })).ok);
    assert.ok((await control.note({ note: 'env.updated', params: { resume: true } })).ok);
    assert.deepEqual(await probe(control), { ok: true, value: { ready: true, paused: false, stopping: false } });
  } finally { await f.close(); }
});

await test('GN-004 startup refusal releases pending health without requiring an attached service', async () => {
  const control = new Control(() => { assert.fail('A refused startup must not project health.'); }, forbidden);
  const pending = probe(control);
  assert.ok((await control.note({ note: 'run.stop', params: {} })).ok);
  const refused = failure('io', 'The service did not initialize.');
  control.ready(refused);
  assert.equal(await pending, refused); assert.equal(control.service, undefined);
});

await test('GN-004 a failed socket open keeps its service attached for shutdown', async () => {
  const root = await mkdtemp('/tmp/service-control-refused-');
  const service = new Service(new ManualClock(), serviceLimits, 'io');
  const control = new Control(() => { assert.fail('A failed socket open must not project health.'); }, forbidden);
  try {
    const opened = await service.open(join(root, 'missing/service.sock'), () => Promise.resolve(success), () => undefined);
    assert.ok(!opened.ok); control.ready(opened, service);
    assert.equal(await probe(control), opened); assert.equal(control.service, service);
  } finally { await service.stop(); await rm(root, { recursive: true, force: true }); }
});

await test('GN-004 a later startup notification preserves attached service ownership and its first health result', async () => {
  const f = await fixture();
  const control = new Control(service => ({ ready: service?.ready }), success);
  try {
    control.ready(success, f.service);
    control.ready(failure('io', 'The service did not finish initialization.'));
    assert.equal(control.service, f.service);
    assert.deepEqual(await probe(control), { ok: true, value: { ready: true } });
  } finally { await f.close(); }
});

await test('GN-004 health and resume retain a failed drain instead of reopening admission', async () => {
  const f = await fixture(); let projections = 0;
  const control = new Control(() => { projections++; return {}; }, forbidden);
  try {
    const connected = await connect(f.path); assert.ok(connected.ok);
    try {
      await f.accepted; control.ready(success, f.service);
      assert.equal(f.service.connections, 1);
      assert.ok((await control.note({ note: 'run.stop', params: {} })).ok);
      const pending = probe(control); await Promise.resolve(); assert.equal(projections, 0);
      f.clock.advance(serviceLimits.drainMs);
      const drained = await pending; assert.ok(!drained.ok); assert.equal(drained.error.code, 'deadline');
      assert.equal(await control.note({ note: 'env.updated', params: { resume: true } }), drained);
      assert.equal(f.service.paused, true); assert.equal(await probe(control), drained);
      assert.equal(projections, 0);
    } finally { connected.value.destroy(); }
  } finally { await f.close(); }
});

await test('GN-004 unmatched notes and resume before attachment use the injected admission policy', async () => {
  for (const policy of [forbidden, success]) {
    const control = new Control(() => ({}), policy);
    assert.equal(await control.note({ note: 'notice', params: {} }), policy);
    assert.equal(await control.note({ note: 'env.updated', params: {} }), policy);
    assert.equal(await control.note({ note: 'env.updated', params: { resume: true } }), policy);
    assert.ok((await control.note({ note: 'run.stop', params: {} })).ok);
  }
});
