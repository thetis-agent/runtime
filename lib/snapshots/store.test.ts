/** Restore exact bytes and refuse changed retained state before creating a copy; GN-002, GN-006. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SnapshotStore } from './store.ts';

await test('GN-006 retained snapshots deduplicate by digest and restore the old bytes', async () => {
  const root = await mkdtemp('/tmp/snapshot-store-'); const source = join(root, 'state'); const saved = join(root, 'saved'); await mkdir(source); await writeFile(join(source, 'value'), 'old');
  try {
    const store = new SnapshotStore(saved); const first = await store.capture(source); assert.ok(first.ok);
    const second = await store.capture(source); assert.deepEqual(second, first); assert.equal((await readdir(saved)).length, 1);
    await writeFile(join(source, 'value'), 'new'); const copy = join(root, 'restored'); assert.ok((await store.restore(first.value, copy)).ok);
    const changed = await store.capture(source); assert.ok(changed.ok); assert.deepEqual(await store.changed(first.value, changed.value), { ok: true, value: ['value'] });
    assert.equal(await readFile(join(copy, 'value'), 'utf8'), 'old'); assert.equal(await readFile(join(source, 'value'), 'utf8'), 'new');
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('GN-002 tampered snapshots and invalid digests are refused before restoring state', async () => {
  const root = await mkdtemp('/tmp/snapshot-tamper-'); const source = join(root, 'state'); const saved = join(root, 'saved'); await mkdir(source); await writeFile(join(source, 'value'), 'old');
  try {
    const store = new SnapshotStore(saved); const captured = await store.capture(source); assert.ok(captured.ok);
    await writeFile(join(saved, captured.value.slice(7), 'value'), 'corrupt');
    assert.ok(!(await store.restore(captured.value, join(root, 'restored'))).ok);
    const invalid = await store.restore('../../outside', join(root, 'restored')); assert.ok(!invalid.ok); assert.equal(invalid.error.code, 'invalid-args');
    assert.equal((await readdir(root)).includes('restored'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
