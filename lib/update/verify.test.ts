/** Defend the early refusal branches ADR 0048's release verification takes before touching a signature; GN-002. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Schemas } from '@/lib/schema/index.ts';
import { verifyRelease, verifyPins } from './verify.ts';

const options = { allowedSigners: '/nonexistent/allowed_signers', signer: 'release@thetis-agent', tag: { tag: 'v1.0.0', commit: '0'.repeat(40) } };

await test('ADR 0048 verifyRelease refuses a release directory that does not exist', async () => {
  const refused = await verifyRelease('/nonexistent/release', options, new Schemas());
  assert.equal(refused.ok, false); assert.equal(refused.error.code, 'io');
});

await test('ADR 0048 verifyRelease refuses a release directory with no SHA256SUMS', async () => {
  const root = await mkdtemp('/assembly/verify-'); try {
    const refused = await verifyRelease(root, options, new Schemas());
    assert.equal(refused.ok, false); assert.equal(refused.error.code, 'io');
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('GN-002 verifyPins refuses a pin naming a directory outside the release tree', async () => {
  const root = await mkdtemp('/assembly/verify-'); try {
    const refused = await verifyPins(root, { '../escaped': `sha256:${'0'.repeat(64)}` });
    assert.equal(refused.ok, false); assert.equal(refused.error.code, 'outside-roots');
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('GN-002 verifyPins refuses a published pin whose directory is missing from the extracted tree', async () => {
  const root = await mkdtemp('/assembly/verify-'); try {
    await mkdir(join(root, 'kernel'));
    const refused = await verifyPins(root, { missing: `sha256:${'0'.repeat(64)}` });
    assert.equal(refused.ok, false); assert.equal(refused.error.code, 'io');
  } finally { await rm(root, { recursive: true, force: true }); }
});
