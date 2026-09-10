/** Exercise immutable local git delivery without package execution; ADR 0007, GN-002. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from './index.ts';
import { retain, retentionMs } from './retention.ts';
import { lock } from './profile.ts';
import { git } from './git.ts';
import { Schemas } from '../schema/index.ts';
import { compact } from './compact.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'registry-case-')); const repository = join(root, 'registry.git');
  assert.equal((await git(repository, ['init', '--bare'])).ok, true);
  const schemas = new Schemas(); await schemas.load(); const result = await Registry.open(repository, schemas); assert.equal(result.ok, true);
  const source = join(root, 'source'); await mkdir(source);
  const manifest = { name: 'sample', version: '1.0.0', requires: {}, provides: { 'service/example': '1.0.0' }, settings: {}, envelope: { requires: [], provides: [], spawn: { scope: 'deployment', network: 'none' } } };
  await writeFile(join(source, 'package.json'), JSON.stringify(manifest)); await writeFile(join(source, 'index.ts'), 'export const stages = {};');
  return { root, source, registry: result.value, manifest };
}
await test('ADR 0006 an unloaded schema service is a programmer error, not a registry I/O failure', async () => {
  const fixtureValue = await fixture();
  try { await assert.rejects(Registry.open(fixtureValue.registry.path, new Schemas()), /can't resolve reference/u); }
  finally { await rm(fixtureValue.root, { recursive: true, force: true }); }
});

await test('ADR 0037 incremental packing preserves exact pins, unreachable objects and fetched bytes', async () => {
  const fixtureValue = await fixture();
  try {
    const pin = await fixtureValue.registry.publish(fixtureValue.source, 'Packed release.', 0); assert.ok(pin.ok);
    const orphan = await git(fixtureValue.registry.path, ['hash-object', '-w', '--stdin'], Buffer.from('retained unreferenced object')); assert.ok(orphan.ok);
    assert.ok((await compact(fixtureValue.registry.path)).ok); assert.ok((await compact(fixtureValue.registry.path)).ok);
    const inspected = await fixtureValue.registry.inspect('sample', '1.0.0'); assert.ok(inspected.ok); assert.deepEqual(inspected.value.pin, pin.value);
    const retained = await git(fixtureValue.registry.path, ['cat-file', 'blob', orphan.value.toString('utf8').trim()]); assert.ok(retained.ok); assert.equal(retained.value.toString(), 'retained unreferenced object');
    const destination = join(fixtureValue.root, 'fetched'); assert.ok((await fixtureValue.registry.fetch(pin.value, destination)).ok);
    assert.equal(await readFile(join(destination, 'index.ts'), 'utf8'), 'export const stages = {};');
  } finally { await rm(fixtureValue.root, { recursive: true, force: true }); }
});

await test('GN-002 registry pins verify before installation and immutable versions reject republish', async () => {
  const f = await fixture();
  try {
    const published = await f.registry.publish(f.source, 'A deterministic release.', 1000000000000); assert.equal(published.ok, true);
    assert.equal((await f.registry.publish(f.source, 'Cannot replace.', 1000000000000)).ok, false);
    const destination = join(f.root, 'installed'); assert.equal((await f.registry.fetch(published.value, destination)).ok, true);
    assert.equal(await readFile(join(destination, 'index.ts'), 'utf8'), 'export const stages = {};');
    assert.equal((await f.registry.fetch({ ...published.value, hash: `sha256:${'0'.repeat(64)}` }, join(f.root, 'bad'))).ok, false);
    assert.deepEqual(await f.registry.search('service/example', '^1'), { ok: true, value: [published.value] });
    assert.deepEqual(await lock(f.registry, [published.value]), { ok: true, value: { version: 1, pins: [published.value] } });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
await test('ADR 0007 publication refuses external dependencies, symlinks and missing registries', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.source, 'package.json'), JSON.stringify({ ...f.manifest, dependencies: { external: '^1' } }));
    assert.equal((await f.registry.publish(f.source, '', 1000000000000)).ok, false);
    await writeFile(join(f.source, 'package.json'), JSON.stringify(f.manifest)); await symlink('/etc/passwd', join(f.source, 'escape'));
    assert.equal((await f.registry.publish(f.source, '', 1000000000000)).ok, false);
    assert.equal((await Registry.open(join(f.root, 'missing'), new Schemas())).ok, false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

await test('ADR 0004 publication ceiling and proposal §13.14 retention preserve live pins and retired identities', async () => {
  const f = await fixture(); const at = 1000000000000;
  try {
    const pins = [];
    for (const version of ['1.0.0', '1.0.1', '1.0.2', '1.0.3']) {
      await writeFile(join(f.source, 'package.json'), JSON.stringify({ ...f.manifest, version }));
      const result = await f.registry.publish(f.source, '', at);
      if (version === '1.0.3') assert.equal(result.ok, false);
      else { if (!result.ok) throw new Error(result.error.message); pins.push(result.value); }
    }
    const first = pins[0]; const second = pins[1]; if (!first || !second) throw new Error('Missing fixture pins.');
    assert.equal((await retain(f.registry, [first], [second], at + retentionMs)).ok, true);
    assert.deepEqual(await f.registry.search('sample', '*'), { ok: true, value: [second] });
    const third = pins[2]; if (!third) throw new Error('Missing retired fixture pin.');
    assert.equal((await git(f.registry.path, ['cat-file', '-e', third.commit])).ok, false);
    assert.equal((await f.registry.fetch(first, join(f.root, 'still-pinned'))).ok, true);
    await writeFile(join(f.source, 'package.json'), JSON.stringify(f.manifest));
    assert.equal((await f.registry.publish(f.source, '', at + retentionMs)).ok, false);
    assert.equal((await retain(f.registry, [], [second], at + retentionMs)).ok, true);
    assert.equal((await f.registry.fetch(first, join(f.root, 'gone'))).ok, false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

await test('ADR 0007 canonical publication omits empty directories and never runs scripts', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.source, 'empty'));
    await writeFile(join(f.source, 'package.json'), JSON.stringify({ ...f.manifest, scripts: { prepublish: 'touch SHOULD-NOT-EXIST' } }));
    const result = await f.registry.publish(f.source, '', 0); assert.equal(result.ok, true);
    const destination = join(f.root, 'delivered'); assert.equal((await f.registry.fetch(result.value, destination)).ok, true);
    await assert.rejects(readFile(join(f.source, 'SHOULD-NOT-EXIST')));
    await assert.rejects(readFile(join(destination, 'SHOULD-NOT-EXIST')));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

await test('SK-015 publication refuses skill-owned checks before creating a release', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.source, 'checks')); await writeFile(join(f.source, 'checks', 'score.ts'), 'process.exitCode = 0;');
    const result = await f.registry.publish(f.source, 'Self scored.', 0);
    assert.equal(result.ok, false); assert.equal(result.error.code, 'forbidden');
    assert.match(result.error.message, /no package scores itself/u);
    assert.deepEqual(await f.registry.versions(), { ok: true, value: [] });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
