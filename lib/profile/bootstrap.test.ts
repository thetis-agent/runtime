/** Pin a reviewed offline bootstrap closure without consuming dev dependencies or package scripts; ADR 0007. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Registry } from '../registry/index.ts';
import { git } from '../registry/git.ts';
import { Schemas } from '../schema/index.ts';
import { bootstrap, writeProfile, readProfile } from './bootstrap.ts';
import { assemble } from './delivery.ts';

async function fixture(root: string): Promise<string> {
  const source = join(root, 'review'); await mkdir(source);
  await writeFile(join(source, 'package.json'), JSON.stringify({ dependencies: { external: '1.0.0' }, devDependencies: { ignored: '1.0.0' } }));
  await writeFile(join(source, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/external': { version: '1.0.0', integrity: 'sha512-fixture', dependencies: { child: '^1' } }, 'node_modules/child': { version: '1.0.0', integrity: 'sha512-fixture' } } }));
  for (const [directory, name] of [['packages/sample', 'sample'], ['lib/helper', '@thetis/lib-helper'], ['contracts/demo', '@thetis/contract-demo'], ['node_modules/external', 'external'], ['node_modules/child', 'child']]) {
    if (!directory || !name) throw new Error('The fixture catalog is invalid.');
    await mkdir(join(source, directory), { recursive: true });
    await writeFile(join(source, directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', ...(name === 'external' ? { dependencies: { child: '^1' }, scripts: { prepare: 'exit 99' } } : {}) }));
    await writeFile(join(source, directory, 'index.ts'), 'export const stages = {};');
  }
  return source;
}
await test('ADR 0007 bootstrap twice preserves pins and materializes only the selected reviewed closure', async () => {
  const root = await mkdtemp('/tmp/bootstrap-case-');
  try {
    const source = await fixture(root); const path = join(root, 'registry'); assert.ok((await git(path, ['init', '--bare'])).ok);
    const schemas = new Schemas(); await schemas.load(); const registry = await Registry.open(path, schemas); assert.ok(registry.ok);
    const first = await bootstrap(source, registry.value, join(root, 'cache'), 0); assert.ok(first.ok, JSON.stringify(first));
    const second = await bootstrap(source, registry.value, join(root, 'cache'), 0); assert.deepEqual(first, second);
    assert.deepEqual(first.value.layers.map(layer => layer.pin.name).sort(), ['child', 'contract/demo', 'external', 'lib/helper', 'sample']);
    assert.ok((await writeProfile(first.value.profile, join(root, 'default'))).ok);
    assert.deepEqual(await readProfile(join(root, 'default/profile.lock.json'), schemas), { ok: true, value: first.value.profile });
    const selected = first.value.profile.pins.filter(item => item.kind !== 'contracts');
    const assembled = await assemble(registry.value, join(root, 'cache'), selected, schemas); assert.ok(assembled.ok, JSON.stringify(assembled));
    await assert.rejects(readFile(join(assembled.value.source, 'contracts/demo/package.json')));
    const external: unknown = JSON.parse(await readFile(join(assembled.value.source, 'node_modules/external/package.json'), 'utf8'));
    assert.ok(typeof external === 'object' && external !== null && 'requires' in external && !('dependencies' in external));
  } finally { await rm(root, { recursive: true, force: true }); }
});
