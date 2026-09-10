/** Preserve short migration exit status even when inherited authority is unused; GN-002. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SandboxRunner } from './index.ts';
import { command } from './command.ts';
import { ManualClock } from '@/lib/events/index.ts';

await test('GN-002 a short migration preserves its exit status without consuming the authority pipe', async () => {
  const root = await mkdtemp('/tmp/migration-exit-'); const entry = join(root, 'entry.ts');
  await writeFile(entry, '/** Script the process exit without using authority; GN-002. */\nprocess.exitCode = Number(process.argv[2]);\n');
  try {
    for (const code of [0, 1, 0, 0, 1, 0]) {
      const result = await command(new SandboxRunner('/cgroup'), { name: 'fixture', version: '1.0.0', entry: '/entry.ts', args: [String(code)], cwd: '/tmp', token: 'unused-test-token', mounts: [{ source: entry, path: '/entry.ts', mode: 'ro' }] }, new ManualClock());
      assert.ok(result.ok, JSON.stringify(result)); assert.deepEqual(result.value, { code, signal: null });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
