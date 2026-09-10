/** Freeze the actual process group while input waits and prove its state remains unchanged; GN-002. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { socketPair } from '@/test/socket-pair.ts';
import { SandboxRunner } from './index.ts';
import type { Mount } from './index.ts';
import { ManualClock } from '@/lib/events/index.ts';

await test('GN-002 the real freezer stops queued writes until state copying is complete', async () => {
  const root = await mkdtemp('/tmp/frozen-state-'); const pair = await socketPair();
  const replies = pair.peer.iterator({ destroyOnReturn: false });
  try {
    const repository = new URL('../..', import.meta.url).pathname.replace(/\/$/u, '');
    const result = await new SandboxRunner('/cgroup').start({ name: 'fixture', version: '1.0.0', entry: `${repository}/test/fixtures/frozen-writer.ts`, args: [], cwd: '/work', socket: pair.client, token: 'test-run', mounts: [
      ...['lib', 'contracts', 'node_modules', 'test/fixtures'].map((name): Mount => ({ source: `${repository}/${name}`, path: `${repository}/${name}`, mode: 'ro' })),
      { source: root, path: '/work', mode: 'rw', maximumBytes: 67108864 }
    ] });
    assert.ok(result.ok);
    try {
      const ready = await replies.next(); assert.ok(!ready.done); const bytes: unknown = ready.value; assert.ok(Buffer.isBuffer(bytes)); assert.equal(bytes.toString(), 'ready\n');
      pair.peer.write('write'); await replies.next(); assert.equal(await readFile(join(root, 'value'), 'utf8'), '1');
      const clock = new ManualClock(); assert.ok((await result.value.freeze(true, clock)).ok);
      pair.peer.write('write'); assert.equal(await readFile(join(root, 'value'), 'utf8'), '1');
      assert.ok((await result.value.freeze(false, clock)).ok); await replies.next();
      assert.equal(await readFile(join(root, 'value'), 'utf8'), '2'); assert.equal((await result.value.exited).code, 0);
    } finally { assert.ok((await result.value.stop()).ok); }
  } finally { await pair.close(); await rm(root, { recursive: true, force: true }); }
});
