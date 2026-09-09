/** Refuse escapes and dangling links before returning a granted canonical path; TE-019. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePath } from './index.ts';

await test('TE-019 canonical roots enforce the destination mode through symlinks', async () => {
  const root = await mkdtemp('/tmp/roots-');
  try {
    const rw = join(root, 'rw'); const ro = join(root, 'ro');
    await mkdir(rw); await mkdir(ro); await writeFile(join(ro, 'file'), 'readable');
    await symlink(ro, join(rw, 'linked')); await symlink('/absent-secret', join(rw, 'dangling'));
    const roots = [{ path: rw, mode: 'rw', space: 'work' }, { path: ro, mode: 'ro', space: 'reference' }] satisfies Parameters<typeof resolvePath>[1];
    assert.deepEqual(await resolvePath('linked/file', roots), { ok: true, value: join(ro, 'file') });
    assert.equal((await resolvePath('linked/file', roots, true)).ok, false);
    assert.equal((await resolvePath('dangling', roots, true)).ok, false);
    assert.deepEqual(await resolvePath('new/deep/file', roots, true), { ok: true, value: join(rw, 'new/deep/file') });
    const absent = await resolvePath('absent', roots); assert.ok(!absent.ok); assert.equal(absent.error.code, 'not-found');
    const escape = await resolvePath('../elsewhere/absent', roots); assert.ok(!escape.ok); assert.equal(escape.error.code, 'outside-roots');
    assert.equal((await resolvePath('\0', roots)).ok, false);
    await mkdir(join(rw, '..legal')); assert.equal((await resolvePath('..legal', roots)).ok, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
