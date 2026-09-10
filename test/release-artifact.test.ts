/** Verify the shipped offline registry independently of source checkout commits; ADR 0007, GN-002. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fileChunks } from '../lib/ndjson/file.ts';
import { readBounded } from '../lib/files/read-bounded.ts';
import { Schemas } from '../lib/schema/index.ts';
import { readProfile } from '../lib/profile/bootstrap.ts';
import { Registry } from '../lib/registry/index.ts';
import { git, reference } from '../lib/registry/git.ts';
import { materialize } from '../lib/profile/index.ts';
import type { Layer } from '../lib/profile/types.ts';
import type { Result } from '../lib/schema/index.ts';
import type { Release } from '../lib/registry/types.ts';

await test('GN-002 the default bundle reconstructs every exact pin offline without source checkout access', async () => {
  const schemas = new Schemas(); await schemas.load();
  const root = await mkdtemp('/assembly/release-'); const release = fileURLToPath(new URL('../profiles/default/', import.meta.url));
  try {
    const profile = await readProfile(join(release, 'profile.lock.json'), schemas); assert.ok(profile.ok, JSON.stringify(profile));
    const raw = await readBounded(join(release, 'registry.json'), 4096); assert.ok(raw.ok);
    const metadata: unknown = JSON.parse(raw.value.toString('utf8'));
    const validate = schemas.compile<{ bundle: string; sha256: string; pins: number }>({ type: 'object', required: ['bundle', 'sha256', 'pins'], properties: {
      bundle: { const: './registry.bundle' }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, pins: { type: 'integer', minimum: 1, maximum: 256 }
    } });
    assert.ok(validate(metadata)); assert.equal(metadata.pins, profile.value.pins.length);
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of fileChunks(join(release, metadata.bundle))) { bytes += chunk.length; assert.ok(bytes <= 67108864); hash.update(chunk); }
    assert.equal(hash.digest('hex'), metadata.sha256);
    const repository = join(root, 'registry'); assert.ok((await git(repository, ['init', '--bare'])).ok);
    assert.ok((await git(repository, ['bundle', 'verify', join(release, metadata.bundle)])).ok);
    assert.ok((await git(repository, ['bundle', 'unbundle', join(release, metadata.bundle)])).ok);
    const registry = await Registry.open(repository, schemas); assert.ok(registry.ok); const layers: Layer[] = [];
    for (const layer of profile.value.pins) {
      assert.ok((await git(repository, ['update-ref', reference(layer.pin.name, layer.pin.version), layer.pin.commit])).ok);
      const inspected: Result<Release> = await registry.value.inspect(layer.pin.name, layer.pin.version); assert.ok(inspected.ok); assert.deepEqual(inspected.value.pin, layer.pin);
      const source = join(root, layer.pin.commit); const fetched = await registry.value.fetch(layer.pin, source); assert.ok(fetched.ok, JSON.stringify(fetched));
      layers.push({ ...layer, source });
    }
    const installed = await materialize(layers, join(root, 'installed'), schemas); assert.ok(installed.ok, JSON.stringify(installed));
    assert.equal(installed.value.layers.length, metadata.pins);
    const changed = profile.value.pins[0]; assert.ok(changed);
    const refused = await registry.value.fetch({ ...changed.pin, hash: `sha256:${'0'.repeat(64)}` }, join(root, 'tampered'));
    assert.ok(!refused.ok && refused.error.code === 'hash-mismatch');
  } finally { await rm(root, { recursive: true, force: true }); }
});
