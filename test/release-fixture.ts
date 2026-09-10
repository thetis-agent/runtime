/** Assemble a complete, signed, offline release fixture from the local workspace; ADR 0048, GN-002. */
import assert from 'node:assert/strict';
import { mkdir, cp, readFile, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { catalog } from '@/lib/profile/catalog.ts';
import { snapshot } from '@/lib/snapshots/index.ts';
import { run } from '@/lib/update/tool.ts';

const fixtureLimits = { archiveBytes: 134217728, toolDeadlineMs: 30000, toolOutputBytes: 4194304 };
/** The eight assets a GitHub Release carries, in the order `docs/ci-delivery.md` lists them. */
export const releaseAssets = ['thetis-distribution.tar.gz', 'package.json', 'profile.lock.json', 'registry.json', 'registry.bundle', 'provenance.json', 'platform.txt', 'kernel-pins.json'] as const;
/** The kernel code pins `test/maintenance.test.ts` hashes, plus `packages`; ADR 0048's `kernel-pins.json`. */
export const kernelPinDirectories = ['kernel', 'lib', 'contracts',
  ...['ajv', 'semver', 'ws', 'yaml', 'fast-uri', 'fast-deep-equal', 'json-schema-traverse', 'require-from-string'].map(name => `node_modules/${name}`), 'packages'];
const testCommit = 'deadbeef'.repeat(5);
const testPackagesCommit = 'cafef00d'.repeat(5);
const signerPrincipal = 'release@thetis-agent';

export interface Fixture { dir: string; tag: string; commit: string; allowedSigners: string; signer: string }

async function signingKey(parent: string): Promise<{ path: string; allowedSigners: string }> {
  const path = join(parent, 'release-key');
  const generated = await run('/usr/bin/ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'zero-release', '-f', path],
    { cwd: parent, deadlineMs: fixtureLimits.toolDeadlineMs, outputBytes: fixtureLimits.toolOutputBytes });
  assert.ok(generated.ok, JSON.stringify(generated));
  const publicKey = (await readFile(`${path}.pub`, 'utf8')).trim();
  const allowedSigners = join(parent, 'allowed_signers');
  await writeFile(allowedSigners, `${signerPrincipal} namespaces="zero-release" ${publicKey}\n`);
  return { path, allowedSigners };
}

async function archive(workspace: string, stage: string, destination: string): Promise<void> {
  await mkdir(stage, { recursive: true });
  for (const name of ['kernel', 'lib', 'contracts', 'packages', 'profiles', 'docs']) await cp(join(workspace, name), join(stage, name), { recursive: true });
  for (const name of ['README.md', 'package.json', 'package-lock.json']) await cp(join(workspace, name), join(stage, name));
  const sources = await catalog(workspace); assert.ok(sources.ok, JSON.stringify(sources));
  for (const source of sources.value.filter(entry => entry.kind === 'node_modules')) await cp(source.source, join(stage, 'node_modules', source.directory), { recursive: true });
  const tarball = join(destination, 'thetis-distribution.tar.gz');
  const tarred = await run('/usr/bin/tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', tarball, '-C', stage, '.'],
    { cwd: stage, deadlineMs: fixtureLimits.toolDeadlineMs, outputBytes: fixtureLimits.toolOutputBytes });
  assert.ok(tarred.ok, JSON.stringify(tarred));
  assert.ok((await stat(tarball)).size <= fixtureLimits.archiveBytes, 'The fixture release archive exceeds its byte budget.');
}

async function kernelPins(workspace: string): Promise<Record<string, string>> {
  const pins: Record<string, string> = {};
  for (const directory of kernelPinDirectories) {
    const hash = await snapshot(join(workspace, directory)); assert.ok(hash.ok, JSON.stringify(hash));
    pins[directory] = hash.value;
  }
  return pins;
}

/** Assemble a complete, signed, offline release into `destination` from `options.workspace`
 * (default `/workspace`), in the installed layout `scripts/distribution.ts` produces. Every test
 * calling this builds `destination` under `/assembly`; the signing key and staging tree land in
 * `destination`'s parent directory, which the caller must already have created (e.g. `mkdtemp`). */
export async function buildRelease(destination: string, options: { tag: string; commit?: string; workspace?: string }): Promise<Fixture> {
  const workspace = options.workspace ?? '/workspace';
  const commit = options.commit ?? testCommit;
  const parent = dirname(destination);
  await mkdir(destination, { recursive: true });
  const key = await signingKey(parent);
  await archive(workspace, join(parent, 'stage'), destination);
  for (const name of ['package.json', 'profile.lock.json', 'registry.json', 'registry.bundle']) {
    await cp(join(workspace, 'profiles', 'default', name), join(destination, name));
  }
  await writeFile(join(destination, 'platform.txt'), 'tar (fixture)\ngzip (fixture)\nssh-keygen (fixture)\nsha256sum (fixture)\n');
  await writeFile(join(destination, 'kernel-pins.json'),
    `${JSON.stringify({ entry: 'kernel/maintenance-main.ts', pins: await kernelPins(workspace) }, null, 2)}\n`);
  const provenance = {
    version: 1,
    runtime: { repository: 'https://github.com/thetis-agent/runtime', commit },
    packages: { repository: 'https://github.com/thetis-agent/packages', commit: testPackagesCommit },
    node: { version: process.version, sha256: { 'linux-x64': createHash('sha256').update('thetis-fixture-node-linux-x64').digest('hex') } },
    generator: 'node:stripTypeScriptTypes:strip', workflow: 'test/release-fixture.ts', run: 'local://release-fixture'
  };
  await writeFile(join(destination, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  const sums = await run('/usr/bin/sha256sum', [...releaseAssets], { cwd: destination, deadlineMs: fixtureLimits.toolDeadlineMs, outputBytes: fixtureLimits.toolOutputBytes });
  assert.ok(sums.ok, JSON.stringify(sums));
  await writeFile(join(destination, 'SHA256SUMS'), sums.value);
  const signed = await run('/usr/bin/ssh-keygen', ['-Y', 'sign', '-n', 'zero-release', '-f', key.path, 'SHA256SUMS'],
    { cwd: destination, deadlineMs: fixtureLimits.toolDeadlineMs, outputBytes: fixtureLimits.toolOutputBytes });
  assert.ok(signed.ok, JSON.stringify(signed));
  return { dir: destination, tag: options.tag, commit, allowedSigners: key.allowedSigners, signer: signerPrincipal };
}
