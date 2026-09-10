/** Keep the operator command's argument surface bounded and keep an unaccepted update policy refused; ADR 0048, ADR 0049. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Schemas } from '@/lib/schema/index.ts';
import { honoured, readInstall, releases, statusPath, controlPath } from './install.ts';
import { readStatus, writeStatus } from './status.ts';
import { options } from './main.ts';

const choices = {
  version: 1 as const, prefix: '/opt/zero', state: '/var/lib/z', release: 'v0.1.0',
  remote: 'https://github.com/thetis-agent/runtime.git', releaseUrl: 'https://github.com/thetis-agent/runtime/releases/download',
  allowedSigners: '/opt/zero/etc/allowed_signers', signer: 'release@thetis-agent', policy: 'none' as const,
  origin: 'https://zero.test', operator: 'op', login: 'login', service: 'system' as const,
};

await test('the operator command takes one verb with named flags and refuses anything else', () => {
  const checked = options(['update', '--check']); assert.ok(checked.ok, JSON.stringify(checked));
  assert.equal(checked.value.command, 'update'); assert.equal(checked.value.options.check, true);
  const applied = options(['update', '--apply', '--release', 'v0.1.1', '--password-fd', '3', '--prefix', '/opt/zero']);
  assert.ok(applied.ok, JSON.stringify(applied));
  assert.equal(applied.value.options.release, 'v0.1.1'); assert.equal(applied.value.options.passwordFd, 3); assert.equal(applied.value.options.prefix, '/opt/zero');
  assert.equal(options([]).ok, false);
  assert.equal(options(['upgrade']).ok, false);
  assert.equal(options(['update']).ok, false);
  assert.equal(options(['update', '--check', '--apply']).ok, false);
  assert.equal(options(['status', '--unknown', 'x']).ok, false);
  assert.equal(options(['update', '--apply', '--password-fd', 'three']).ok, false);
  assert.equal(options(new Array(20).fill('status')).ok, false);
  for (const command of ['status', 'undo', 'prune-releases']) assert.ok(options([command]).ok);
});

await test('an update policy other than none stays refused with the record that would have to accept it', () => {
  const none = honoured('none'); assert.ok(none.ok); assert.equal(none.value, 'none');
  for (const policy of ['fixes', 'improvements'] as const) {
    const refused = honoured(policy);
    assert.equal(refused.ok, false); assert.equal(refused.error.code, 'forbidden');
    assert.match(refused.error.message, /ADR 0049/u);
    assert.match(refused.error.message, new RegExp(policy, 'u'));
  }
});

await test('the recorded installation choices and the update status file are read only within their bounds', async () => {
  const root = await mkdtemp('/tmp/install-'); const schemas = new Schemas(); await schemas.load();
  try {
    await mkdir(join(root, 'etc'), { recursive: true });
    assert.equal((await readInstall(root, schemas)).ok, false);
    await writeFile(join(root, 'etc/install.json'), JSON.stringify({ ...choices, prefix: root }));
    const read = await readInstall(root, schemas); assert.ok(read.ok, JSON.stringify(read));
    assert.equal(read.value.operator, 'op'); assert.equal(read.value.policy, 'none');
    assert.equal(releases(read.value), join(root, 'releases'));
    assert.equal(statusPath(read.value), '/var/lib/z/updates/status.json');
    assert.equal(controlPath(read.value), '/var/lib/z/supervisor.sock');
    await writeFile(join(root, 'etc/install.json'), JSON.stringify({ ...choices, policy: 'daily' }));
    assert.equal((await readInstall(root, schemas)).ok, false);
    await writeFile(join(root, 'etc/install.json'), '{');
    assert.equal((await readInstall(root, schemas)).ok, false);
    const status = join(root, 'updates/status.json');
    const absent = await readStatus(status, schemas); assert.ok(absent.ok); assert.equal(absent.value, undefined);
    assert.ok((await writeStatus(status, { version: 1, current: 'v0.1.0', available: 'v0.1.1', verified: true, checkedAt: 1, stagedAt: 2, policy: 'none' })).ok);
    const written = await readStatus(status, schemas); assert.ok(written.ok); assert.equal(written.value?.available, 'v0.1.1');
    await writeFile(status, JSON.stringify({ version: 1, current: 'nightly', verified: true, checkedAt: 1, policy: 'none' }));
    assert.equal((await readStatus(status, schemas)).ok, false);
    await writeFile(status, 'x'.repeat(70000));
    const oversized = await readStatus(status, schemas); assert.equal(oversized.ok, false); assert.equal(oversized.error.code, 'budget');
  } finally { await rm(root, { recursive: true, force: true }); }
});
