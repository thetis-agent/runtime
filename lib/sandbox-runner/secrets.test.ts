/** Deliver an actual registered secret through the actual sandbox runner; PR-013, ADR 0019. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Secrets } from '@/kernel/secrets/index.ts';
import { socketPair } from '@/test/socket-pair.ts';
import { SandboxRunner } from './index.ts';
import type { Running } from './index.ts';

async function output(run: Running): Promise<{ stdout: string; stderr: string }> {
  const result = { stdout: '', stderr: '' };
  for (const name of ['stdout', 'stderr'] satisfies ('stdout' | 'stderr')[]) run.process[name]?.on('data', (chunk: Buffer) => {
    result[name] += chunk.toString(); if (result[name].length > 4096) throw new Error('The secret probe exceeded its output limit.');
  });
  await run.exited; return result;
}

await test('PR-013 registered spawn keys reach the package environment without argv, mount or log copies', async () => {
  const root = await mkdtemp('/tmp/spawn-secret-'); const pair = await socketPair(); const value = randomBytes(32).toString('base64url');
  try {
    const store = await Secrets.open(root, randomBytes(32)); assert.ok(store.ok);
    assert.ok((await store.value.set({ id: 'admin', role: 'admin', projects: [], observeOthers: false }, 'kernel', { scope: 'deployment', name: 'secret/llm-key', value })).ok);
    assert.ok(store.value.register('service-run', 'deployment', ['secret/llm-key']).ok);
    const secret = await store.value.deliver('service-run', 'secret/llm-key'); assert.ok(secret.ok);
    const result = await new SandboxRunner('/cgroup').start({ name: 'fixture', version: '1.0.0', entry: '/entry.ts', cwd: '/tmp', args: [createHash('sha256').update(value).digest('hex')], socket: pair.client, token: 'test-run', secrets: { VENDOR_API_KEY: Buffer.from(secret.value).toString() }, mounts: [
      { source: new URL('../../test/fixtures/spawn-secret.ts', import.meta.url).pathname, path: '/entry.ts', mode: 'ro' }
    ] });
    assert.ok(result.ok); const observed = await output(result.value); assert.equal((await result.value.exited).code, 0, observed.stderr);
    assert.deepEqual(JSON.parse(observed.stdout), { delivered: true, exposed: false, importedWithSecret: true });
    assert.equal(JSON.stringify(observed).includes(value), false); assert.equal(JSON.stringify(result.value.process.spawnargs).includes(value), false);
    for (const name of await readdir(root)) assert.equal((await readFile(join(root, name))).includes(Buffer.from(value)), false);
    assert.ok((await result.value.dispose()).ok); store.value.revoke('service-run');
  } finally { await pair.close(); await rm(root, { recursive: true, force: true }); }
});

await test('Spawn delivery cannot overwrite runtime controls or exceed its byte budget', async () => {
  const pair = await socketPair();
  try {
    const runner = new SandboxRunner('/cgroup');
    const plan = { name: 'fixture', version: '1.0.0', entry: '/entry.ts', cwd: '/tmp', args: [], socket: pair.client, token: 'test-run', mounts: [
      { source: new URL('../../test/fixtures/spawn-secret.ts', import.meta.url).pathname, path: '/entry.ts', mode: 'ro' as const }
    ] };
    const large = await runner.start({ ...plan, secrets: { VENDOR_API_KEY: 'x'.repeat(65536) } }); assert.ok(!large.ok); assert.equal(large.error.code, 'budget');
    const result = await runner.start({ ...plan, secrets: { NODE_OPTIONS: '--inspect' } }); assert.ok(result.ok);
    const observed = await output(result.value); assert.equal((await result.value.exited).code, 1); assert.equal(observed.stdout, '');
    assert.equal(observed.stderr.includes('--inspect'), false); assert.ok((await result.value.dispose()).ok);
  } finally { await pair.close(); }
});
