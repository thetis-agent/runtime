/** Assemble reviewed trees without widening the selected target's package set; GN-002, ADR 0017. */
import { mkdir, mkdtemp, realpath, rename, rm, readFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { snapshot } from '../snapshots/index.ts';
import { immutableLinks } from '../snapshots/link.ts';
import { failure, isObject } from '../schema/index.ts';
import type { Result, Schemas } from '../schema/index.ts';
import { validator } from './schema.ts';
import type { Layer, Install, Package } from './types.ts';
export type { Layer, Install, Profile } from './types.ts';
export const limits = { layers: 256, operations: 1, workEntries: 256, debounceMs: 50, pending: 256 };
export const mount = '/opt/thetis-runtime';
let active = 0;

async function copy(layer: Layer, destination: string, immutable: boolean): Promise<Result<Package | undefined>> {
  const target = join(destination, layer.kind, layer.directory); await mkdir(dirname(target), { recursive: true, mode: 0o755 });
  const copied = await (immutable ? immutableLinks(layer.source, target) : snapshot(layer.source, target)); if (!copied.ok) return copied;
  if (copied.value !== layer.pin.hash) return failure('hash-mismatch', 'The selected package tree does not match its pinned hash.');
  if (layer.kind !== 'packages') return { ok: true, value: undefined };
  const raw: unknown = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  if (!isObject(raw) || raw['name'] !== layer.pin.name || raw['version'] !== layer.pin.version) return failure('invalid-args', 'The installed package manifest does not match its pin.');
  return { ok: true, value: { name: layer.pin.name, version: layer.pin.version, entry: join(mount, layer.kind, layer.directory, 'index.ts'), manifest: raw } };
}
export async function materialize(layers: readonly Layer[], destination: string, schemas: Schemas, immutable = false): Promise<Result<Install>> {
  if (active >= limits.operations || layers.length > limits.layers) return failure('budget', 'The profile installation pool or layer limit is full.');
  active++; let temporary: string | undefined;
  try {
    const check = await validator<Layer>(schemas, 'layer');
    if (!layers.every(layer => check(layer))) return failure('invalid-args', 'The profile layer does not match its schema.');
    const directories = new Set(layers.map(layer => `${layer.kind}/${layer.directory}`)); const names = new Set(layers.map(layer => layer.pin.name));
    if (directories.size !== layers.length || names.size !== layers.length) return failure('conflict', 'The profile contains overlapping package layers.');
    const parent = await realpath(dirname(destination)); const target = join(parent, basename(destination));
    temporary = await mkdtemp(join(parent, '.profile-')); const packages: Package[] = [];
    for (const layer of layers) { const copied = await copy(layer, temporary, immutable); if (!copied.ok) return copied; if (copied.value) packages.push(copied.value); }
    const hash = await snapshot(temporary); if (!hash.ok) return hash;
    await rename(temporary, target);
    return { ok: true, value: { source: target, hash: hash.value, mount, packages, layers: structuredClone([...layers]), aliases: layers.map(layer => ({ source: join(target, layer.kind, layer.directory), hash: layer.pin.hash, mount: `/packages/${layer.pin.name}@${layer.pin.version}` })) } };
  } catch { return failure('io', 'The profile could not be assembled from its selected package trees.'); }
  finally { if (temporary) await rm(temporary, { recursive: true, force: true }); active--; }
}
