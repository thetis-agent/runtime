/** Verify byte-exact recovery material without hashing on the request loop; GN-002. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { snapshot } from './index.ts';

await test('Snapshot copies have the same hash independent of tree creation order', async () => {
  const root = await mkdtemp('/tmp/snapshot-');
  try {
    const source = join(root, 'source'); await mkdir(source);
    await writeFile(join(source, 'b'), 'beta'); await writeFile(join(source, 'a'), 'alpha');
    const hashed = await snapshot(source); assert.ok(hashed.ok);
    assert.deepEqual(await snapshot(source, join(root, 'copy')), hashed);
    const other = join(root, 'other'); await mkdir(other);
    await writeFile(join(other, 'a'), 'alpha'); await writeFile(join(other, 'b'), 'beta');
    assert.deepEqual(await snapshot(other), hashed);
    await writeFile(join(other, 'b'), 'changed'); assert.notDeepEqual(await snapshot(other), hashed);
    await symlink('/outside', join(other, 'escape')); assert.equal((await snapshot(other)).ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('Snapshot copy refuses an existing destination without changing its contents', async () => {
  const root = await mkdtemp('/tmp/snapshot-');
  try {
    const source = join(root, 'source'); const destination = join(root, 'destination');
    await mkdir(source); await mkdir(destination);
    await writeFile(join(source, 'new'), 'new'); await writeFile(join(destination, 'existing'), 'keep');
    const original = await snapshot(destination); assert.ok(original.ok);
    assert.equal((await snapshot(source, destination)).ok, false);
    assert.deepEqual(await snapshot(destination), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});
