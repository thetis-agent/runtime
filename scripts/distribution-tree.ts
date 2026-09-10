/** Assemble and hash the exact installed tree; GN-002 and verified execution artifacts. */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { catalog } from '@/lib/profile/catalog.ts';
import { snapshot } from '@/lib/snapshots/index.ts';
import { verifyPins } from '@/lib/update/verify.ts';
import { run } from '@/lib/update/tool.ts';

export const kernelPinDirectories = ['kernel', 'lib', 'contracts',
  ...['ajv', 'semver', 'ws', 'yaml', 'fast-uri', 'fast-deep-equal', 'json-schema-traverse', 'require-from-string'].map(name => `node_modules/${name}`),
  'packages'];
const limits = { deadlineMs: 60000, outputBytes: 1048576 };

export async function kernelPins(root: string): Promise<{ entry: string; pins: Record<string, string> }> {
  const pins: Record<string, string> = {};
  for (const directory of kernelPinDirectories) {
    const hash = await snapshot(join(root, directory));
    if (!hash.ok) throw new Error(`${directory}: ${hash.error.message}`);
    pins[directory] = hash.value;
  }
  return { entry: 'kernel/maintenance-main.ts', pins };
}

export async function distributionTree(root: string, stage: string): Promise<void> {
  await mkdir(stage, { recursive: true });
  const sources = await catalog(root);
  if (!sources.ok) throw new Error(sources.error.message);
  for (const source of sources.value) {
    await cp(source.source, join(stage, source.kind, source.directory), { recursive: true, errorOnExist: true, force: false });
  }
  for (const path of ['kernel', 'profiles', 'docs', 'README.md', 'package.json', 'package-lock.json']) {
    await cp(join(root, path), join(stage, path), { recursive: true, errorOnExist: true, force: false });
  }
}

/** Development checkout metadata never participates in published directory hashes. */
export async function buildDistribution(root: string, stage: string, output: string): Promise<void> {
  await mkdir(output, { recursive: true });
  await distributionTree(root, stage);
  const manifest = await kernelPins(stage);
  await writeFile(join(output, 'kernel-pins.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const archived = await run('/usr/bin/tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
    '-czf', join(output, 'thetis-distribution.tar.gz'), '-C', stage, '.'], { cwd: root, ...limits });
  if (!archived.ok) throw new Error(archived.error.message);
}

/** Exercise the customer's extraction, including file modes, before signing or publishing. */
export async function verifyDistribution(output: string, extracted: string): Promise<void> {
  await mkdir(extracted, { recursive: true });
  const unpacked = await run('/usr/bin/tar', ['-xpzf', join(output, 'thetis-distribution.tar.gz'), '--no-same-owner', '-C', extracted],
    { cwd: output, ...limits });
  if (!unpacked.ok) throw new Error(unpacked.error.message);
  const manifest = await kernelPins(extracted);
  const published = await readFile(join(output, 'kernel-pins.json'), 'utf8');
  if (`${JSON.stringify(manifest, null, 2)}\n` !== published) throw new Error('The extracted distribution differs from its published kernel pins.');
  const verified = await verifyPins(extracted, manifest.pins);
  if (!verified.ok) throw new Error(verified.error.message);
}
