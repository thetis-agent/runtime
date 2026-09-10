/** Defend the signed release fixture every installer/updater test builds on; ADR 0048, GN-002. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Schemas } from '@/lib/schema/index.ts';
import { verifyRelease, verifyPins, verifyLimits } from '@/lib/update/verify.ts';
import { run } from '@/lib/update/tool.ts';
import { buildRelease, kernelPinDirectories } from '@/test/release-fixture.ts';
import type { Fixture } from '@/test/release-fixture.ts';

function options(fixture: Fixture, allowedSigners = fixture.allowedSigners) {
  return { allowedSigners, signer: fixture.signer, tag: { tag: fixture.tag, commit: fixture.commit } };
}

const root = await mkdtemp('/assembly/rf-');
try {
  const schemas = new Schemas(); await schemas.load();
  const fixture = await buildRelease(join(root, 'release'), { tag: 'v1.2.3' });

  const verified = await verifyRelease(fixture.dir, options(fixture), schemas);
  assert.ok(verified.ok, JSON.stringify(verified));

  await test('GN-002 verifyRelease accepts a complete signed offline release and reports its kernel pins', () => {
    assert.ok(verified.ok);
    assert.equal(verified.value.entry, 'kernel/maintenance-main.ts');
    assert.equal(Object.keys(verified.value.pins).length, kernelPinDirectories.length);
    assert.equal(verified.value.provenance.runtime.commit, fixture.commit);
  });

  const extracted = join(root, 'extracted');
  await mkdir(extracted);
  const unpacked = await run('/usr/bin/tar', ['-xzf', join(fixture.dir, 'thetis-distribution.tar.gz'), '-C', extracted],
    { cwd: extracted, deadlineMs: verifyLimits.deadlineMs, outputBytes: verifyLimits.sumsBytes });
  assert.ok(unpacked.ok, JSON.stringify(unpacked));

  await test('ADR 0048 verifyPins accepts every published kernel pin and the extracted execution artifacts', async () => {
    assert.ok(verified.ok);
    const pinned = await verifyPins(extracted, verified.value.pins);
    assert.ok(pinned.ok, JSON.stringify(pinned));
  });

  await test('GN-002 verifyPins refuses an altered kernel pin hash', async () => {
    assert.ok(verified.ok);
    const tampered = { ...verified.value.pins, kernel: `sha256:${'0'.repeat(64)}` };
    const refused = await verifyPins(extracted, tampered);
    assert.equal(refused.ok, false); assert.equal(refused.error.code, 'hash-mismatch');
  });

  await test('GN-002 verifyRelease refuses a release whose SHA256SUMS no longer matches a listed asset', async () => {
    const variant = join(root, 'tampered-registry'); await cp(fixture.dir, variant, { recursive: true });
    const path = join(variant, 'registry.json'); const bytes = await readFile(path);
    bytes[0] = (bytes[0] ?? 0) ^ 0xff; await writeFile(path, bytes);
    const refused = await verifyRelease(variant, options(fixture), schemas);
    assert.equal(refused.ok, false); assert.equal(refused.error.code, 'hash-mismatch');
  });

  await test('GN-002 verifyRelease refuses a release missing its SHA256SUMS signature', async () => {
    const variant = join(root, 'missing-signature'); await cp(fixture.dir, variant, { recursive: true });
    await rm(join(variant, 'SHA256SUMS.sig'));
    const refused = await verifyRelease(variant, options(fixture), schemas);
    assert.equal(refused.ok, false);
  });

  await test('ADR 0048 verifyRelease refuses a release signed by a key absent from allowed_signers', async () => {
    const otherKey = join(root, 'other-key');
    const generated = await run('/usr/bin/ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'zero-release', '-f', otherKey],
      { cwd: root, deadlineMs: verifyLimits.deadlineMs, outputBytes: 4194304 });
    assert.ok(generated.ok, JSON.stringify(generated));
    const otherPublicKey = (await readFile(`${otherKey}.pub`, 'utf8')).trim();
    const otherAllowedSigners = join(root, 'other-allowed-signers');
    await writeFile(otherAllowedSigners, `${fixture.signer} namespaces="zero-release" ${otherPublicKey}\n`);
    const refused = await verifyRelease(fixture.dir, options(fixture, otherAllowedSigners), schemas);
    assert.equal(refused.ok, false); assert.equal(refused.error.code, 'forbidden');
  });

  await test('ADR 0048 verifyRelease refuses provenance whose commit differs from the peeled tag', async () => {
    const refused = await verifyRelease(fixture.dir, { allowedSigners: fixture.allowedSigners, signer: fixture.signer, tag: { tag: fixture.tag, commit: `f${fixture.commit.slice(1)}` } }, schemas);
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'conflict'); assert.ok(refused.error.message.includes(fixture.tag), JSON.stringify(refused));
  });
} finally { await rm(root, { recursive: true, force: true }); }
