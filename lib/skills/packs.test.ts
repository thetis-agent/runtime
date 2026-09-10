/** Discovery is by alias layout, not by registry: lib/profile/index.ts aliases every selected package
 * at `/packages/<name>@<version>`, which is the only shape `card.path` accepts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Schemas } from '@/lib/schema/index.ts';
import { installedPacks, loadInstalled } from '@/lib/skills/index.ts';
import { skill } from '@/test/skills-fixture.ts';

async function pack(root: string, alias: string, skills: Readonly<Record<string, string>> = {}): Promise<string> {
  const path = join(root, alias);
  await mkdir(join(path, 'skills'), { recursive: true });
  for (const [id, text] of Object.entries(skills)) {
    await mkdir(join(path, 'skills', id), { recursive: true });
    await writeFile(join(path, 'skills', id, 'SKILL.md'), text);
  }
  return path;
}

await test('a package with a skills directory is found and split into name and version', async () => {
  const root = join('/packages', `scratch-${randomUUID()}`);
  try {
    await pack(root, 'skills-team@2.3.0');
    await pack(root, 'skills-ops@1.0.0-rc.1');
    assert.deepEqual(await installedPacks(root), [
      { name: 'skills-ops', version: '1.0.0-rc.1', path: join(root, 'skills-ops@1.0.0-rc.1') },
      { name: 'skills-team', version: '2.3.0', path: join(root, 'skills-team@2.3.0') }
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('a package without a skills directory is not a pack, and neither is an unaliased name', async () => {
  const root = join('/packages', `scratch-${randomUUID()}`);
  try {
    await mkdir(join(root, 'gateway-web@1.0.0'), { recursive: true });
    await pack(root, 'skills');
    await writeFile(join(root, 'skills-team@1.0.0'), 'not a directory');
    assert.deepEqual(await installedPacks(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('a missing packages root is empty rather than an error', async () => {
  assert.deepEqual(await installedPacks(join('/packages', `absent-${randomUUID()}`)), []);
});

await test('a pack that cannot load is named and skipped, never taking the other packs with it', async () => {
  const id = `alpha-${randomUUID()}`;
  const good = `pack-good-${randomUUID()}@1.0.0`; const bad = `pack-bad-${randomUUID()}@1.0.0`;
  const schemas = new Schemas(); await schemas.load();
  try {
    await pack('/packages', good, { [id]: skill(id) });
    await symlink('/etc', join(await pack('/packages', bad), 'skills', 'linked'));
    const loaded = await loadInstalled(schemas);
    assert.deepEqual(loaded.skills.filter(item => item.card.id === id).map(item => item.card.pack), [good.slice(0, -6)]);
    assert.ok(loaded.warnings.some(warning => warning.startsWith(`${bad.slice(0, -6)}@1.0.0 was skipped:`)), loaded.warnings.join('; '));
  } finally { for (const alias of [good, bad]) await rm(join('/packages', alias), { recursive: true, force: true }); }
});

await test('one id in two packs yields no skills at all, because which body won would be arbitrary', async () => {
  const id = `alpha-${randomUUID()}`;
  const one = `pack-one-${randomUUID()}@1.0.0`; const two = `pack-two-${randomUUID()}@1.0.0`;
  const schemas = new Schemas(); await schemas.load();
  try {
    for (const alias of [one, two]) await pack('/packages', alias, { [id]: skill(id) });
    const loaded = await loadInstalled(schemas);
    assert.deepEqual(loaded.skills, []);
    assert.ok(loaded.warnings.some(warning => warning.includes(`${id} is provided by both`)), loaded.warnings.join('; '));
  } finally { for (const alias of [one, two]) await rm(join('/packages', alias), { recursive: true, force: true }); }
});
