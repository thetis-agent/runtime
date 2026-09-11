/** Exercise the root publication boundary inside a nested user namespace without host privileges; implementation note 0052. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sourceFlags } from '@/lib/artifacts/index.ts';
import { run } from './tool.ts';

// A nested namespace maps a single identity, so the staging account cannot be impersonated here; what it leaves on its files can be.
function fakeRoot(root: string, script: string): ReturnType<typeof run> {
  return run('/usr/bin/bwrap', ['--unshare-user', '--uid', '0', '--gid', '0', '--bind', '/', '/', '--',
    process.execPath, ...sourceFlags(), '--input-type=module', '-e', script, join(root, 'prefix')],
  { cwd: '/workspace', deadlineMs: 30000, outputBytes: 65536 });
}

await test('system activation privately copies activated code into a root-owned tree', async () => {
  const root = await mkdtemp('/tmp/adopt-');
  const script = `
    import assert from 'node:assert/strict';
    import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
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
  `;
  try {
    const result = await fakeRoot(root, script);
    assert.ok(result.ok, JSON.stringify(result));
  } finally { await rm(root, { recursive: true, force: true }); }
});

// `thetis update --check` stages as the service account, so the tree activation copies carries that account's umask and identity.
// Until activation took ownership itself it published whatever the copy happened to carry, and on Node 24.18.0 a filtered
// `fs.cpSync` carries the source owner back, which left every system-service apply refused by its own verification walk.
await test('implementation note 0052 activation takes ownership of the copy it publishes rather than inheriting the staging modes', async () => {
  const root = await mkdtemp('/tmp/adopt-owner-');
  const script = `
    import assert from 'node:assert/strict';
    import { mkdir, writeFile, readFile, stat, chmod } from 'node:fs/promises';
    import { join } from 'node:path';
    import { adopt } from '/workspace/lib/update/adopt.ts';
    process.umask(0o000);
    const prefix = process.argv[1]; const release = join(prefix, 'releases/v0.1.0');
    const entries = ['.release', '.release/SHA256SUMS', 'kernel-pins.json', 'code', 'lib', 'lib/nested', 'lib/nested/helper', 'helper'];
    async function stage() {
      await mkdir(join(release, '.release'), {recursive:true, mode:0o700});
      await mkdir(join(release, 'lib/nested'), {recursive:true, mode:0o777});
      await writeFile(join(release, '.release/SHA256SUMS'), 'signed', {mode:0o666});
      await writeFile(join(release, 'kernel-pins.json'), '{}', {mode:0o666});
      await writeFile(join(release, 'code'), 'verified bytes', {mode:0o666});
      await writeFile(join(release, 'lib/nested/helper'), 'nested bytes', {mode:0o666});
      await writeFile(join(release, 'helper'), 'privileged bytes', {mode:0o755});
      await chmod(join(release, 'helper'), 0o4755);
    }
    async function owned(result) {
      assert.ok(result.ok, JSON.stringify(result));
      for (const entry of entries) {
        const info = await stat(join(release, entry));
        const mode = (info.mode & 0o7777).toString(8);
        assert.equal(info.uid, 0, entry + ' is owned by ' + info.uid);
        assert.equal(info.gid, 0, entry + ' is grouped under ' + info.gid);
        assert.equal(info.mode & 0o022, 0, entry + ' stays writable as ' + mode);
        assert.equal(info.mode & 0o6000, 0, entry + ' keeps a set-user-ID or set-group-ID bit as ' + mode);
      }
      assert.equal(await readFile(join(release, 'code'), 'utf8'), 'verified bytes');
      assert.equal(await readFile(join(release, 'lib/nested/helper'), 'utf8'), 'nested bytes');
    }
    try {
      await stage();
      await owned(await adopt({service:'system', prefix}, release));
      // A write bit reappearing under an already published release is taken back on the next apply, not carried into it.
      await chmod(join(release, 'code'), 0o666);
      await owned(await adopt({service:'system', prefix}, release));
      process.stdout.write('adopted');
    } catch (error) { process.stdout.write('refused: ' + (error instanceof Error ? error.message : String(error))); }
  `;
  try {
    const result = await fakeRoot(root, script);
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.value.toString('utf8'), 'adopted');
  } finally { await rm(root, { recursive: true, force: true }); }
});
