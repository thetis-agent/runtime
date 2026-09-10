/** Exercise selected provisioning functions and recorded uninstall resources while faking only host-manager commands; implementation note 0052. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { command, install } from './installer-fixture.ts';

await test('dry-run follows user, foreground, split and TPM2 provisioning choices', async () => {
  const base = ['--origin', 'https://thetis.test', '--operator', 'op', '--dry-run'];
  const user = await install([...base, '--service', 'user', '--no-mount'], false);
  assert.equal(user.status, 0, user.stderr);
  assert.match(user.stdout, /systemctl --user enable --now thetis-update.timer/u);
  assert.match(user.stdout, /\.config\/systemd\/user\/thetis.service/u);
  assert.doesNotMatch(user.stdout, /useradd|\/etc\/systemd\/system|\/etc\/thetis/u);
  const foreground = await install([...base, '--service', 'none', '--no-mount'], false);
  assert.equal(foreground.status, 0, foreground.stderr);
  assert.match(foreground.stdout, /chmod 0600 \/opt\/thetis\/etc\/master.key/u);
  assert.doesNotMatch(foreground.stdout, /systemctl|loginctl|useradd/u);
  const tpm = await install([...base, '--key-store', 'tpm2', '--state-layout', 'split'], false);
  assert.equal(tpm.status, 0, tpm.stderr);
  assert.match(tpm.stdout, /systemd-creds encrypt --with-key=tpm2 --name=master/u);
  for (const name of ['kernel', 'supervisor', 'g']) assert.match(tpm.stdout, new RegExp(`var-lib-thetis-${name}\\.mount`, 'u'));
  assert.match(tpm.stdout, /fallocate -l 2147483648 \/var\/lib\/thetis\/g.img/u);
  assert.doesNotMatch(tpm.stdout, /head -c 32 \/dev\/urandom > \/etc\/thetis/u);
});

await test('rendered user services omit system identity and mount hardening; TPM2 uses encrypted credentials', async () => {
  const root = await mkdtemp('/tmp/unit-');
  try {
    const harness = '. "$1/defaults.sh"; . "$1/units.sh"; . "$1/provision.sh"; service=$2; key_store=$3; state_layout=split; credential_path=$4; write_unit thetis.service "$5"; write_unit thetis-update.service "$6"';
    const run = (service: string, key: string, credential: string) => command('/bin/sh', ['-c', harness, 'units', '/workspace/scripts/installer', service, key, credential, join(root, 'thetis.service'), join(root, 'update.service')], false);
    const user = await run('user', 'file', '/home/operator/thetis/etc/master.key'); assert.equal(user.status, 0, user.stderr);
    const rendered = await readFile(join(root, 'thetis.service'), 'utf8');
    assert.doesNotMatch(rendered, /^(?:User|Group|ProtectHome|ProtectSystem|DeviceAllow|ReadWritePaths)=/mu);
    assert.match(rendered, /^WantedBy=default.target$/mu); assert.match(rendered, /^Delegate=yes$/mu);
    assert.match(rendered, /^LoadCredential=master:\/home\/operator\/thetis\/etc\/master.key$/mu);
    assert.doesNotMatch(await readFile(join(root, 'update.service'), 'utf8'), /^(?:User|Group|ProtectHome|ProtectSystem)=/mu);
    const system = await run('system', 'tpm2', '/etc/thetis/master.key'); assert.equal(system.status, 0, system.stderr);
    const encrypted = await readFile(join(root, 'thetis.service'), 'utf8');
    assert.match(encrypted, /^LoadCredentialEncrypted=master:\/etc\/thetis\/master.key$/mu);
    assert.match(encrypted, /^RequiresMountsFor=\/var\/lib\/thetis \/var\/lib\/thetis\/kernel \/var\/lib\/thetis\/supervisor \/var\/lib\/thetis\/g$/mu);
    assert.match(encrypted, /^User=thetis$/mu); assert.doesNotMatch(encrypted, /^LoadCredential=/mu);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('user uninstall reads its recorded manager, preserves state and key, and makes no writes in dry-run', async () => {
  const root = await mkdtemp('/tmp/user-'); const prefix = join(root, 'opt'); const state = join(root, 'state');
  const home = join(root, 'home'); const units = join(home, '.config/systemd/user'); const bin = join(root, 'bin'); const log = join(root, 'commands');
  try {
    for (const path of [join(prefix, 'etc'), join(prefix, 'node/current/bin'), state, units, bin]) await mkdir(path, { recursive: true });
    await symlink('/runtime/bin/node', join(prefix, 'node/current/bin/node'));
    const credential = join(prefix, 'etc/master.key'); await writeFile(credential, Buffer.alloc(32, 1), { mode: 0o600 });
    await writeFile(join(state, 'saved'), 'retained state');
    for (const unit of ['thetis.service', 'thetis-update.service', 'thetis-update.timer']) await writeFile(join(units, unit), 'test unit');
    await writeFile(join(prefix, 'etc/install.json'), JSON.stringify({ version: 1, prefix, state, service: 'user', serviceUser: 'thetis',
      stateLayout: 'one', noMount: true, keyStore: 'file', credential, unitDirectory: units, lingerCreated: true, userCreated: false }));
    for (const name of ['systemctl', 'loginctl']) await writeFile(join(bin, name), '#!/bin/sh\nprintf "%s %s\\n" "${0##*/}" "$*" >> "$MANAGER_LOG"\n', { mode: 0o755 });
    const environment = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, MANAGER_LOG: log };
    const planned = await install(['--prefix', prefix, '--uninstall', '--dry-run'], false, environment);
    assert.equal(planned.status, 0, planned.stderr); assert.ok((await stat(credential)).isFile());
    assert.equal(await stat(log).then(() => true, () => false), false);
    const removed = await install(['--prefix', prefix, '--uninstall', '--service', 'system'], false, environment);
    assert.equal(removed.status, 0, removed.stderr);
    const commands = await readFile(log, 'utf8');
    assert.match(commands, /systemctl --user disable --now thetis-update.timer thetis.service/u);
    assert.match(commands, /systemctl --user daemon-reload/u); assert.match(commands, /loginctl disable-linger/u);
    assert.doesNotMatch(commands, /systemctl (?!\x2d\x2duser)/u);
    assert.equal(await stat(prefix).then(() => true, () => false), false);
    assert.equal(await readFile(join(state, 'saved'), 'utf8'), 'retained state');
    assert.equal((await stat(join(state, 'retained-master.key'))).mode & 0o777, 0o600);
    assert.equal(await stat(join(units, 'thetis.service')).then(() => true, () => false), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('installer refuses unsafe paths and unsupported custody combinations before provisioning', async () => {
  for (const prefix of ['/', '/opt/../etc', '/opt/thetis;false']) {
    const refused = await install(['--prefix', prefix, '--origin', 'https://thetis.test', '--dry-run'], false);
    assert.equal(refused.status, 1, prefix);
  }
  const tpmUser = await install(['--service', 'user', '--no-mount', '--key-store', 'tpm2', '--origin', 'https://thetis.test', '--dry-run'], false);
  assert.equal(tpmUser.status, 1); assert.match(tpmUser.stderr, /TPM2 credentials require/u);
});
