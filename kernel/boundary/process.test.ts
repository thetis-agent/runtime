/** Drive real sandboxed control endpoints with deterministic deadlines; GN-001, GN-003. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Process } from '@/kernel/boundary/process.ts';
import type { Context } from '@/kernel/boundary/process.ts';
import { Identity } from '@/kernel/identity/index.ts';
import { Journal, limits as logLimits } from '@/kernel/log/index.ts';
import { Schemas, isObject } from '@/lib/schema/index.ts';
import { ManualClock } from '@/lib/events/index.ts';
import { SandboxRunner } from '@/lib/sandbox-runner/index.ts';
import type { Mount } from '@/lib/sandbox-runner/index.ts';
import type { Method } from '@/contracts/kernel-socket/types.ts';
import type { Operation } from '@/kernel/socket/index.ts';

async function fixture(mode = 'healthy', settings = logLimits) {
  const root = await mkdtemp('/tmp/process-control-'); const clock = new ManualClock(); const schemas = new Schemas(); await schemas.load();
  const journal = await Journal.open(join(root, 'observed.jsonl'), () => clock.now(), settings); assert.ok(journal.ok);
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
  return { process: started.value, clock, authenticate: () => identity.authenticate(token.value), rows: () => readFile(join(root, 'observed.jsonl'), 'utf8'), async close() {
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
    assert.deepEqual(result.value.conversations, ['stuck']);
    assert.match(await f.rows(), /"reason":"killed-for-switch"/u); assert.match(await f.rows(), /"provenance":"kernel-observed"/u);
    const turns = (await f.rows()).trim().split('\n').map((line): unknown => JSON.parse(line)).filter(isObject).filter(row => row['kind'] === 'turn.start' || row['kind'] === 'turn.end');
    assert.equal(turns.length, 4);
    for (const conversation of ['cooperative', 'stuck']) {
      const pair = turns.filter(row => isObject(row['data']) && row['data']['conversation'] === conversation);
      const start = pair[0]; const end = pair[1]; assert.ok(start && end && isObject(start['data']) && isObject(end['data']));
      assert.equal(start['kind'], 'turn.start'); assert.equal(end['kind'], 'turn.end');
      assert.equal(start['data']['turn'], end['data']['turn']);
      assert.equal(end['data']['outcome'], conversation === 'cooperative' ? 'response' : 'error');
      assert.equal(end['data']['elapsedMs'], conversation === 'cooperative' ? 0 : 30000);
      assert.ok(pair.every(row => row['provenance'] === 'kernel-observed'));
    }
  } finally { await f.close(); }
});

await test('KS-001 a process crash closes its inherited control endpoint without waiting for a probe timer', async () => {
  const f = await fixture();
  try {
    assert.ok((await f.process.probe()).ok);
    assert.ok(f.process.running.process.kill('SIGKILL')); await f.process.running.exited;
    const ended = await f.process.exited; assert.equal(ended.expected, false); assert.ok(ended.result.ok);
    assert.equal(f.process.alive, false); assert.ok(!f.authenticate().ok); assert.ok(!(await f.process.running.events()).ok);
    const result = await f.process.control.call('health.probe', {}); assert.ok(!result.ok); assert.equal(result.error.code, 'io');
    assert.match(await f.rows(), /"reason":"unexpected process exit"/u);
    assert.ok((await f.process.stop('already observed')).ok);
    assert.equal((await f.rows()).match(/"kind":"process.exit"/gu)?.length, 1);
  } finally { await f.close(); }
});

await test('ADR-0019 log exhaustion refuses a turn before the environment receives it', async () => {
  const f = await fixture('healthy', { ...logLimits, bytes: 1152, recoveryBytes: 1024 });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await f.process.invoke('session.submit', { conversation: 'cooperative', input: {} });
      assert.ok(!result.ok); assert.equal(result.error.code, 'budget');
    }
    const health = await f.process.control.call('health.probe', {}); assert.ok(health.ok && isObject(health.value));
    assert.equal(health.value['active'], 0);
    assert.equal((await f.rows()).trim().split('\n').length, 1);
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
