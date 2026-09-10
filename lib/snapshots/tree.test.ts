/** Preserve published snapshot digests while keeping blocking file work off the request loop; GN-002. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashTree } from './tree.ts';
import { snapshot } from './index.ts';

await test('GN-002 blocking tree hashing refuses to run on the request thread', async () => {
  const root = await mkdtemp('/tmp/tree-thread-');
  try {
    const refused = await hashTree(root); assert.ok(!refused.ok); assert.equal(refused.error.code, 'invalid-args');
    assert.ok((await snapshot(root)).ok);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('GN-002 snapshot streaming preserves the established binary, path and mode digest format', async () => {
  const root = await mkdtemp('/tmp/tree-format-'); const source = join(root, 'source');
  try {
    await mkdir(source); await mkdir(join(source, 'nested')); await chmod(join(source, 'nested'), 0o750);
    const bytes = Buffer.alloc(150001); for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256;
    await writeFile(join(source, 'nested/é'), bytes); await chmod(join(source, 'nested/é'), 0o640);
    await writeFile(join(source, 'empty'), ''); await chmod(join(source, 'empty'), 0o600);
    const digest = createHash('sha256').update(JSON.stringify(['empty', 'file', 0o600, 0]))
      .update(JSON.stringify(['nested', 'directory', 0o750, 0]))
      .update(JSON.stringify(['nested/é', 'file', 0o640, bytes.length])).update(bytes).digest('hex');
    const expected = { ok: true, value: `sha256:${digest}` };
    assert.deepEqual(await snapshot(source), expected); assert.deepEqual(await snapshot(source, join(root, 'copy')), expected);
    await chmod(join(source, 'nested/é'), 0o600); assert.notDeepEqual(await snapshot(source), expected);
  } finally { await rm(root, { recursive: true, force: true }); }
});
