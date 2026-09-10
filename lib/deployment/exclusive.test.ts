/** Serialize kernel boot and remove only an unreachable socket owned by its private root; ADR 0030. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { mkdtemp, rename, writeFile, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { exclusive, retireOrigin } from './exclusive.ts';
import { ManualClock } from '@/lib/events/index.ts';
await test('The deployment OS lock refuses a concurrent kernel and releases after shutdown', async () => {
  const root = await mkdtemp('/tmp/kernel-lock-'); const clock = new ManualClock();
  const first = await exclusive(root, clock); assert.ok(first.ok);
  try {
    const second = await exclusive(root, clock); assert.ok(!second.ok); assert.equal(second.error.code, 'conflict');
  } finally { assert.ok((await first.value.close()).ok); }
  const third = await exclusive(root, clock); assert.ok(third.ok); assert.ok((await third.value.close()).ok); await rm(root, { recursive: true, force: true });
});
await test('Origin retirement refuses live sockets and regular files, then removes a stale socket', async () => {
  const root = await mkdtemp('/tmp/origin-retire-'); const path = join(root, 'live.sock'); const stale = join(root, 'stale.sock');
  const server = createServer(socket => { socket.destroy(); });
  await new Promise<void>(resolve => { server.listen(path, () => { resolve(); }); });
  try { const live = await retireOrigin(root, path); assert.ok(!live.ok); assert.equal(live.error.code, 'conflict'); await rename(path, stale); }
  finally { await new Promise<void>(resolve => { server.close(() => { resolve(); }); }); }
  assert.ok((await retireOrigin(root, stale)).ok); assert.ok(!await lstat(stale).catch(() => undefined));
  await writeFile(path, 'preserve'); const regular = await retireOrigin(root, path); assert.ok(!regular.ok); assert.equal(regular.error.code, 'outside-roots');
  await rm(root, { recursive: true, force: true });
});
