/** Release checks exercise the same archive and pins customers install; GN-002. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildDistribution, kernelPins, verifyDistribution } from '@/scripts/distribution-tree.ts';

await test('the production distribution hashes only shipped files and survives installer extraction', async () => {
  const root = await mkdtemp('/assembly/dist-');
  try {
    const delivery = join(root, 'delivery'); const stage = join(root, 'stage');
    await buildDistribution('/workspace', stage, delivery);
    assert.equal(await stat(join(stage, 'packages/README.md')).then(() => true, () => false), false);
    assert.equal(await stat(join(stage, 'packages/.git')).then(() => true, () => false), false);
    assert.equal(await stat(join(stage, 'packages/.github')).then(() => true, () => false), false);
    const previous = process.umask(0o077);
    try { await verifyDistribution(delivery, join(root, 'extracted')); }
    finally { process.umask(previous); }
    const manifest = await kernelPins(stage);
    assert.equal(await readFile(join(delivery, 'kernel-pins.json'), 'utf8'), `${JSON.stringify(manifest, null, 2)}\n`);
    manifest.pins['packages'] = `sha256:${'0'.repeat(64)}`;
    await writeFile(join(delivery, 'kernel-pins.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(verifyDistribution(delivery, join(root, 'tampered')), /differs from its published kernel pins/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
