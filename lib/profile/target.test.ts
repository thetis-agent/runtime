/** Preserve captured process declarations while planning neutral kernel inputs; KS-009, GN-002. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { materialize } from './index.ts';
import type { Options } from './target.ts';
import { target } from './target.ts';
import { cache } from './cache.ts';
import { Schemas } from '../schema/index.ts';
import { snapshot } from '../snapshots/index.ts';
import type { Layer } from './types.ts';
import type { Registration } from '../package-loader/types.ts';
await test('KS-009 neutral deployment plans retain immutable declared spawn and service mounts', async () => {
  const root = await mkdtemp('/tmp/target-case-'); const source = join(root, 'source'); await mkdir(source);
  try {
    const manifest = { name: 'example', version: '1.0.0', type: 'module', requires: {}, provides: {}, settings: {}, envelope: { requires: [], provides: [], spawn: { scope: 'deployment', network: 'none' } } };
    await writeFile(join(source, 'package.json'), JSON.stringify(manifest)); await writeFile(join(source, 'index.ts'), 'export const stages = {};'); await writeFile(join(source, 'service.ts'), 'export {};');
    const hash = await snapshot(source); assert.ok(hash.ok);
    const layer: Layer = { kind: 'packages', directory: 'example', source, pin: { name: 'example', version: '1.0.0', commit: 'a'.repeat(40), hash: hash.value } };
    const schemas = new Schemas(); await schemas.load(); const installed = await materialize([layer], join(root, 'installed'), schemas); assert.ok(installed.ok);
    const declaration: Registration = { requires: {}, provides: {}, spawn: [{ id: 'example', cmd: 'node', args: ['/opt/thetis-runtime/packages/example/service.ts'], env: {}, scope: 'deployment', network: 'none', restart: 'on-failure', health: { rpc: 'health.probe' } }] };
    const options = { id: 'sample', owner: '', scope: 'deployment', state: '/initial/state', package: 'example', entry: 'service.ts', profile: {}, services: [{ id: 'another', mount: '/services/another' }], captured: { source: 'example@1.0.0', registration: declaration, id: 'example' } } satisfies Options;
    const planned = await target(installed.value, options, schemas); assert.ok(planned.ok);
    assert.deepEqual(planned.value.registration?.['declared'], declaration.spawn?.[0]);
    assert.equal(planned.value.revision.pins['layout']?.hash, installed.value.hash); assert.deepEqual(planned.value.services, ['another']);
    assert.deepEqual(planned.value.revision.mounts, [{ source: 'service:another', path: '/services/another', mode: 'ro' }]);
    assert.equal((await target(installed.value, { ...options, args: ['unexpected'] }, schemas)).ok, false);
    const inService = { ...installed.value, source: installed.value.source.replace(root, '/cache'), aliases: installed.value.aliases.map(alias => ({ ...alias, source: alias.source.replace(root, '/cache') })), layers: installed.value.layers.map(layer => ({ ...layer, source: layer.source.replace(root, '/cache') })) };
    assert.deepEqual(await cache(inService, root, schemas), installed);
    assert.equal((await cache({ ...inService, source: '/cache/../outside' }, root, schemas)).ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
