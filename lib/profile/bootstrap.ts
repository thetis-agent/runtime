/** Publish an explicit reviewed bootstrap closure with new hashes for normalized manifests; proposal §5–6, ADR 0007. */
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Registry } from '../registry/index.ts';
import { normalize } from '../registry/tree.ts';
import { snapshot } from '../snapshots/index.ts';
import { failure, isObject } from '../schema/index.ts';
import type { Result, Schemas } from '../schema/index.ts';
import { catalog } from './catalog.ts';
import type { Source } from './catalog.ts';
import type { Layer, Profile } from './types.ts';
import { atomicWrite } from '../files/atomic.ts';
import { compact } from '../registry/compact.ts';

function manifest(source: Source, original: string): Record<string, unknown> {
  const value = Object.fromEntries(Object.entries(source.manifest).filter(([key]) => !['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].includes(key)));  const requires: Record<string, unknown> = isObject(value['requires']) ? { ...value['requires'] } : {};
  if (source.kind === 'node_modules' && isObject(source.manifest['dependencies'])) for (const [name, range] of Object.entries(source.manifest['dependencies'])) requires[name.replace(/^@/u, '')] = range;
  return { ...value, name: source.name, requires, provides: value['provides'] ?? {}, settings: value['settings'] ?? {}, envelope: value['envelope'] ?? { requires: [], provides: [], spawn: { scope: 'deployment', network: 'none' } },
    thetisSource: { name: source.manifest['name'], hash: original, ...(source.integrity ? { integrity: source.integrity } : {}) } };
}
async function publish(registry: Registry, source: Source, root: string, at: number): Promise<Result<Layer>> {
  const prepared = join(root, 'package'); const copied = await snapshot(source.source, prepared); if (!copied.ok) return copied;
  const metadata = manifest(source, copied.value); await writeFile(join(prepared, 'package.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  const normalized = await normalize(prepared); if (!normalized.ok) return normalized;
  const hash = await snapshot(prepared); if (!hash.ok) return hash;
  if (typeof metadata['version'] !== 'string') return failure('invalid-args', 'The bootstrap package has no exact version.');
  let published = await registry.inspect(source.name, metadata['version']);
  if (!published.ok && published.error.code === 'not-found') {
    const pin = await registry.publish(prepared, 'Reviewed deployment bootstrap closure.', at); if (!pin.ok) return pin;
    published = { ok: true, value: { pin: pin.value, note: '', at } };
  }
  if (!published.ok) return published;
  if (published.value.pin.hash !== hash.value) return failure('conflict', 'The bootstrap version already exists with a different reviewed tree.');
  return { ok: true, value: { kind: source.kind, directory: source.directory, source: prepared, pin: published.value.pin } };
}
export async function bootstrap(repository: string, registry: Registry, cache: string, at: number): Promise<Result<{ profile: Profile; layers: Layer[] }>> {
  const sources = await catalog(repository); if (!sources.ok) return sources;
  const temporary = await mkdtemp(join(tmpdir(), 'profile-review-'));
  try {
    await mkdir(cache, { recursive: true, mode: 0o700 }); const layers: Layer[] = [];
    for (const [index, source] of sources.value.entries()) {
      const directory = join(temporary, String(index)); await mkdir(directory);
      const released = await publish(registry, source, directory, at); if (!released.ok) return released;
      const packed = await compact(registry.path); if (!packed.ok) return packed;
      const destination = join(cache, released.value.pin.commit); let fetched = await snapshot(destination);
      if (!fetched.ok) { const installed = await registry.fetch(released.value.pin, destination); if (!installed.ok) return installed; fetched = await snapshot(destination); }
      if (!fetched.ok || fetched.value !== released.value.pin.hash) return failure('hash-mismatch', 'The bootstrap cache does not match its pin.');
      layers.push({ ...released.value, source: destination });
      await rm(directory, { recursive: true, force: true });
    }
    const profile: Profile = { name: 'default', version: '1.0.0', pins: layers.map(({ kind, directory, pin }) => ({ kind, directory, pin })) };
    return { ok: true, value: { profile, layers } };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
export async function writeProfile(profile: Profile, directory: string): Promise<Result<void>> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const manifest = { name: profile.name, version: profile.version, private: true, type: 'module', dependencies: Object.fromEntries(profile.pins.map(item => [item.pin.name, item.pin.version])) };
    const written = await atomicWrite(join(directory, 'package.json'), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)); if (!written.ok) return written;
    return await atomicWrite(join(directory, 'profile.lock.json'), Buffer.from(`${JSON.stringify(profile, null, 2)}\n`));
  } catch { return failure('io', 'The default profile files could not be written.'); }
}
export async function readProfile(path: string, schemas: Schemas): Promise<Result<Profile>> {
  const { validator } = await import('./schema.ts');
  try { const value: unknown = JSON.parse(await readFile(path, 'utf8')); return (await validator<Profile>(schemas, 'profile'))(value) ? { ok: true, value } : failure('invalid-args', 'The default profile lock is invalid.'); }
  catch { return failure('io', 'The default profile lock could not be read.'); }
}
