/** Prove blob reuse is limited to immutable caches, never mutable snapshot isolation; GN-002, ADR 0037. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { immutableLinks } from './link.ts';
import { snapshot } from './index.ts';
await test('GN-002 immutable cache profiles share blobs while generation copies remain isolated', async () => {
  const root = await mkdtemp('/tmp/linked-pins-'); const source = join(root, 'source');
  try {
    await mkdir(source); await mkdir(join(source, 'nested')); await writeFile(join(source, 'nested/data'), 'reviewed');
    const destination = join(root, 'linked'); const linked = await immutableLinks(source, destination); assert.ok(linked.ok); assert.deepEqual(linked, await snapshot(source));
    const original = await lstat(join(source, 'nested/data')); const shared = await lstat(join(destination, 'nested/data')); assert.equal(original.ino, shared.ino);
    const isolated = join(root, 'generation'); assert.ok((await snapshot(destination, isolated)).ok);
    await writeFile(join(isolated, 'nested/data'), 'private state'); assert.equal(await readFile(join(source, 'nested/data'), 'utf8'), 'reviewed');
    assert.ok(!(await immutableLinks(source, source)).ok); assert.ok(!(await immutableLinks(source, destination)).ok);
    await symlink(join(source, 'nested/data'), join(source, 'escape')); assert.ok(!(await immutableLinks(source, join(root, 'refused'))).ok);
  } finally { await rm(root, { recursive: true, force: true }); }
});
