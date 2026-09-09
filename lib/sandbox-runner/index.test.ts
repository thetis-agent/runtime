/** Use the actual bubblewrap adapter and real cgroups, never a fake runner; ADR 0005, TE-024. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import { join } from 'node:path';
import type { Mount, Plan } from './index.ts';
import { SandboxRunner } from './index.ts';
import { Cgroup } from './cgroup.ts';

await test('The sandbox rejects ordinary directories masquerading as resource controls', async () => {
  const root = await mkdtemp('/tmp/not-cgroup-');
  try { assert.equal((await Cgroup.create(root)).ok, false); }
  finally { await rm(root, { recursive: true, force: true }); }
});

await test('TE-024 the real runner transfers authority only by inherited descriptors', async () => {
  const root = await mkdtemp('/tmp/runner-'); const path = join(root, 'authority.sock');
  const work = join(root, 'work'); await mkdir(work);
  const server = createServer();
  const received = new Promise<string>((resolve, reject) => { server.once('connection', socket => {
    let bytes = ''; socket.on('error', reject);
    socket.on('data', (chunk: Buffer) => { bytes += chunk.toString(); if (bytes.length > 4096) { socket.destroy(); reject(new Error('Probe reply limit exceeded.')); } });
    socket.on('end', () => { resolve(bytes); socket.end(); });
  }); });
  await new Promise<void>(resolve => { server.listen(path, resolve); });
  const socket = createConnection(path); await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  try {
    const repository = new URL('../..', import.meta.url).pathname.replace(/\/$/u, '');
    const runner = new SandboxRunner('/cgroup');
    const plan = { name: 'fixture', version: '1.0.0', entry: `${repository}/test/fixtures/sandbox-child.ts`, args: [], cwd: '/work', socket, token: 'test-run', mounts: [
      ...['lib', 'contracts', 'node_modules', 'test/fixtures'].map((name): Mount => ({ source: `${repository}/${name}`, path: `${repository}/${name}`, mode: 'ro' })),
      { source: work, path: '/work', mode: 'rw', maximumBytes: 67108864 }
    ] } satisfies Plan;
    const quota = await runner.start({ ...plan, mounts: [{ source: work, path: '/work', mode: 'rw', maximumBytes: 1 }] });
    assert.ok(!quota.ok); assert.equal(quota.error.code, 'gap');
    assert.equal(quota.error.message, 'fixture 1.0.0 requires cap/storage.quota *. Nothing in this profile provides it. No configured registry provides it.');
    const control = await new SandboxRunner(root).start(plan); assert.ok(!control.ok); assert.equal(control.error.code, 'gap');
    const result = await runner.start(plan);
    assert.ok(result.ok, JSON.stringify(result));
    let errors = ''; result.value.process.stderr?.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
    const exit = await result.value.exited; assert.equal(exit.code, 0, errors);
    assert.ok((await result.value.dispose()).ok);
    assert.deepEqual(JSON.parse(await received), { closeOnExec: true, outside: true, tokenMatches: true });
    assert.equal(await readFile(join(work, 'result'), 'utf8'), 'sandboxed');
  } finally {
    socket.destroy(); await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); });
    await rm(root, { recursive: true, force: true });
  }
});

await test('The real sandbox memory ceiling kills an allocation beyond its limit', async () => {
  const root = await mkdtemp('/tmp/runner-memory-'); const path = join(root, 'authority.sock');
  const server = createServer(socket => { socket.on('end', () => { socket.end(); }); });
  await new Promise<void>(resolve => { server.listen(path, resolve); });
  const socket = createConnection(path); await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  try {
    const entry = new URL('../../test/fixtures/sandbox-memory.ts', import.meta.url).pathname;
    const runner = new SandboxRunner('/cgroup');
    const result = await runner.start({ name: 'fixture', version: '1.0.0', entry: '/entry.ts', args: [], cwd: '/tmp', socket, token: 'test-run', mounts: [{ source: entry, path: '/entry.ts', mode: 'ro' }] });
    assert.ok(result.ok, JSON.stringify(result));
    await result.value.exited;
    const events = await result.value.events(); assert.ok(events.ok); assert.ok((events.value['oom_kill'] ?? 0) >= 1);
    assert.ok((await result.value.dispose()).ok);
  } finally {
    socket.destroy(); await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); });
    await rm(root, { recursive: true, force: true });
  }
});
