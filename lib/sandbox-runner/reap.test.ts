/** Prove exclusive startup stops orphan writers before any recovery snapshot; GN-003, ADR 0012. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rmdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { SandboxRunner } from './index.ts';
import type { Mount } from './index.ts';
import { socketPair } from '../socket/pair.ts';

await test('GN-003 exclusive startup reaps actual orphan sandbox writers and preserves other delegated roots', async () => {
  const control = `/cgroup/test-reap-${randomUUID()}`; await mkdir(control); await writeFile(join(control, 'cgroup.subtree_control'), '+cpu +memory +pids');
  const state = await mkdtemp('/tmp/reap-'); const runner = new SandboxRunner(control); const pair = await socketPair(); assert.ok(pair.ok);
  try {
    assert.ok(!(await new SandboxRunner(state).reap()).ok);
    const repository = new URL('../..', import.meta.url).pathname.replace(/\/$/u, '');
    const ready = new Promise<void>(resolve => { pair.value.peer.once('data', () => { resolve(); }); }); pair.value.peer.resume();
    const started = await runner.start({ name: 'fixture', version: '1.0.0', entry: `${repository}/test/fixtures/sandbox-orphan.ts`, args: [], cwd: '/state', token: 'run', socket: pair.value.client, mounts: [
      ...['lib', 'contracts', 'node_modules', 'test/fixtures'].map((name): Mount => ({ source: `${repository}/${name}`, path: `${repository}/${name}`, mode: 'ro' })),
      { source: state, path: '/state', mode: 'rw', maximumBytes: 67108864 }
    ] }); assert.ok(started.ok, JSON.stringify(started)); await ready;
    assert.deepEqual(await runner.reap(), { ok: true, value: 1 }); await started.value.exited;
    assert.equal(await readFile(join(state, 'value'), 'utf8'), 'live'); assert.deepEqual(await runner.reap(), { ok: true, value: 0 });
    await mkdir(join(control, 'run-invalid')); assert.ok(!(await runner.reap()).ok); await rmdir(join(control, 'run-invalid'));
  } finally { assert.ok((await runner.reap()).ok); assert.ok((await pair.value.close()).ok); await rmdir(control); await rm(state, { recursive: true, force: true }); }
});
