/** Exercise the root publication boundary inside a nested user namespace without host privileges; ADR 0052. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sourceFlags } from '@/lib/artifacts/index.ts';
import { run } from './tool.ts';

await test('system activation privately copies root-owned code and refuses writable release entries', async () => {
  const root = await mkdtemp('/tmp/adopt-');
  const script = `
    import assert from 'node:assert/strict';
    import { mkdir, writeFile, readFile, readdir, stat, chmod } from 'node:fs/promises';
    import { join } from 'node:path';
    import { adopt } from '/workspace/lib/update/adopt.ts';
    const prefix = process.argv[1]; const release = join(prefix, 'releases/v0.1.0');
    await mkdir(join(release, '.release'), {recursive:true, mode:0o700});
    await writeFile(join(release, '.release/SHA256SUMS'), 'signed', {mode:0o600});
    await writeFile(join(release, 'kernel-pins.json'), '{}', {mode:0o600});
    await writeFile(join(release, 'code'), 'verified bytes', {mode:0o644});
    const before = await stat(join(release, 'code'));
    assert.equal(process.getuid(), 0);
    const result = await adopt({service:'system', prefix}, release);
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(await readFile(join(release, 'code'), 'utf8'), 'verified bytes');
    assert.notEqual((await stat(join(release, 'code'))).ino, before.ino);
    assert.equal((await stat(join(release, 'code'))).uid, 0);
    assert.equal((await stat(release)).mode & 0o777, 0o755);
    assert.equal((await stat(join(release, '.release'))).mode & 0o777, 0o755);
    assert.deepEqual(await readdir(prefix), ['releases']);
    await chmod(join(release, 'code'), 0o666);
    const refused = await adopt({service:'system', prefix}, release);
    assert.equal(refused.ok, false); assert.equal(refused.error.code, 'outside-roots');
    assert.equal(await readFile(join(release, 'code'), 'utf8'), 'verified bytes');
    assert.deepEqual(await readdir(prefix), ['releases']);
  `;
  try {
    const result = await run('/usr/bin/bwrap', ['--unshare-user', '--uid', '0', '--gid', '0', '--bind', '/', '/', '--',
      process.execPath, ...sourceFlags(), '--input-type=module', '-e', script, join(root, 'prefix')],
    { cwd: '/workspace', deadlineMs: 30000, outputBytes: 65536 });
    assert.ok(result.ok, JSON.stringify(result));
  } finally { await rm(root, { recursive: true, force: true }); }
});
