/** Drive real sandboxed control endpoints with deterministic deadlines; GN-001, GN-003. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Process } from './process.ts';
import type { Context } from './process.ts';
import { Identity } from '../identity/index.ts';
import { Journal } from '../log/index.ts';
import { Schemas, isObject } from '../../lib/schema/index.ts';
import { ManualClock } from '../../lib/events/index.ts';
import { SandboxRunner } from '../../lib/sandbox-runner/index.ts';
import type { Mount } from '../../lib/sandbox-runner/index.ts';
import type { Method } from '../../contracts/kernel-socket/types.ts';
import type { Operation } from '../socket/index.ts';

async function fixture(mode = 'healthy') {
  const root = await mkdtemp('/tmp/process-control-'); const clock = new ManualClock(); const schemas = new Schemas(); await schemas.load();
  const journal = await Journal.open(join(root, 'observed.jsonl'), () => clock.now()); assert.ok(journal.ok);
  const identity = new Identity({ people: [{ id: 'alice', role: 'user', projects: [], observeOthers: false }], authorities: {}, bindings: [] }, () => clock.now());
  const token = identity.issue({ id: 'run', person: 'alice', scope: 'person', target: 'alice', generation: 1, services: [] }); assert.ok(token.ok);
  const context: Context = { target: 'alice', identity, schemas, clock, journal: journal.value, runner: new SandboxRunner('/cgroup'), operations: {
    methods: new Map<Method, Operation>([['health.probe', () => Promise.resolve({ ok: true, value: { ready: true } })], ['session.submit', () => Promise.resolve({ ok: true, value: null })]]),
    notes: ['run.stop'], note: () => Promise.resolve({ ok: true, value: undefined })
  } };
  const repository = new URL('../..', import.meta.url).pathname.replace(/\/$/u, '');
  const started = await Process.start({ name: 'fixture', version: '1.0.0', entry: `${repository}/test/fixtures/controlled-process.ts`, args: [mode], cwd: '/tmp', mounts: [
    ...['lib', 'contracts', 'node_modules', 'test/fixtures'].map((name): Mount => ({ source: `${repository}/${name}`, path: `${repository}/${name}`, mode: 'ro' }))
  ] }, token.value, context); assert.ok(started.ok, JSON.stringify(started));
  return { process: started.value, clock, rows: () => readFile(join(root, 'observed.jsonl'), 'utf8'), async close() {
    const stopped = await started.value.stop('test complete'); await journal.value.close(); await rm(root, { recursive: true, force: true }); assert.ok(stopped.ok, JSON.stringify(stopped));
  } };
}

await test('GN-001 real cooperative and stuck turns drain or are killed at the injected deadline', async () => {
  const f = await fixture();
  try {
    assert.ok((await f.process.probe()).ok);
    const cooperative = f.process.invoke('session.submit', { conversation: 'cooperative', input: {} });
    const stuck = f.process.invoke('session.submit', { conversation: 'stuck', input: {} });
    let active: unknown;
    for (let attempt = 0; attempt < 32 && active !== 2; attempt++) {
      const status = await f.process.control.call('health.probe', {}); assert.ok(status.ok); assert.ok(isObject(status.value)); active = status.value['active'];
    }
    assert.equal(active, 2);
    const draining = f.process.drain(30000); assert.ok((await cooperative).ok); f.clock.advance(30000);
    const result = await draining; assert.ok(result.ok); assert.equal(result.value.killed, true); assert.ok(!(await stuck).ok);
    assert.match(await f.rows(), /"reason":"killed-for-switch"/u); assert.match(await f.rows(), /"provenance":"kernel-observed"/u);
  } finally { await f.close(); }
});

await test('GN-003 an actual process that never answers its probe can be stopped after the injected deadline', async () => {
  const f = await fixture('unhealthy');
  try {
    const probe = f.process.probe(); f.clock.advance(10000);
    const result = await probe; assert.ok(!result.ok); assert.equal(result.error.code, 'deadline');
    assert.ok((await f.process.stop('probe deadline')).ok); assert.notEqual((await f.process.running.exited).signal, null);
  } finally { await f.close(); }
});
