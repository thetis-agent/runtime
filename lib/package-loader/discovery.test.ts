/** Discover plain packages without mistaking registry metadata for code; ADR 0035, KS-009. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { discover } from './index.ts';
import { Schemas } from '@/lib/schema/index.ts';

await test('KS-009 discovery ignores repository metadata and refuses a package symlink outside its root', async () => {
  const root = await mkdtemp('/tmp/package-discovery-');
  const schemas = new Schemas(); await schemas.load();
  try {
    const registry = join(root, 'packages'); await mkdir(registry);
    await mkdir(join(registry, '.git')); await writeFile(join(registry, 'README.md'), 'Registry documentation.');
    await mkdir(join(registry, 'sample'));
    await writeFile(join(registry, 'sample/package.json'), JSON.stringify({ name: 'sample', version: '1.0.0',
      requires: {}, provides: {}, settings: {}, envelope: { requires: [], provides: [], spawn: { scope: 'person', network: 'none' } } }));
    await writeFile(join(registry, 'sample/index.ts'), 'export const stages = {};');
    const result = await discover(registry, '/state', {}, schemas); assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.value.map(entry => entry.manifest.name), ['sample']);
    await mkdir(join(root, 'outside')); await symlink(join(root, 'outside'), join(registry, 'escape'));
    const escaped = await discover(registry, '/state', {}, schemas); assert.ok(!escaped.ok);
    assert.equal(escaped.error.code, 'outside-roots');
  } finally { await rm(root, { recursive: true, force: true }); }
});
