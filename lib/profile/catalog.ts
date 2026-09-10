/** Discover review inputs without executing manifests or installing external code; proposal §5, ADR 0007. */
import { readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { readBounded } from '../files/read-bounded.ts';
import { failure, isObject } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';
import type { Layer } from './types.ts';
import { packagesRoot } from './packages-root.ts';
export interface Source { kind: Layer['kind']; directory: string; source: string; name: string; manifest: Record<string, unknown>; integrity?: string }
const limits = { directories: 256, manifestBytes: 1048576, lockBytes: 4194304 };

async function object(path: string, bytes = limits.manifestBytes): Promise<Result<Record<string, unknown>>> {
  const file = await readBounded(path, bytes); if (!file.ok) return file;
  try { const value: unknown = JSON.parse(file.value.toString('utf8')); return isObject(value) ? { ok: true, value } : failure('invalid-args', 'The review manifest is not an object.'); }
  catch { return failure('invalid-args', 'The review manifest is not valid JSON.'); }
}
async function directory(root: string, kind: 'packages' | 'lib' | 'contracts'): Promise<Result<Source[]>> {
  const base = kind === 'packages' ? packagesRoot(root) : join(root, kind);
  const names = await readdir(base, { withFileTypes: true }); const result: Source[] = [];
  if (names.length > limits.directories) return failure('budget', 'The review directory exceeds its package limit.');
  for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const name = entry.name;
    if (!/^[a-z][a-z0-9-]*$/u.test(name)) return failure('invalid-args', 'The review directory contains an invalid package name.');
    const source = await realpath(join(base, name)); if (source !== join(base, name)) return failure('outside-roots', 'The review package is not a canonical directory.');
    const manifest = await object(join(source, 'package.json')); if (!manifest.ok) return manifest;
    result.push({ kind, directory: name, source, name: kind === 'packages' ? name : `${kind === 'contracts' ? 'contract' : 'lib'}/${name}`, manifest: manifest.value });
  }
  return { ok: true, value: result };
}
async function vendors(root: string): Promise<Result<Source[]>> {
  const manifest = await object(join(root, 'package.json')); if (!manifest.ok) return manifest;
  const lock = await object(join(root, 'package-lock.json'), limits.lockBytes); if (!lock.ok) return lock;
  const packages = lock.value['packages']; const dependencies = manifest.value['dependencies'];
  if (!isObject(packages) || !isObject(dependencies)) return failure('invalid-args', 'The runtime dependency lock is invalid.');
  const pending = Object.keys(dependencies); const found = new Map<string, Source>();
  while (pending.length) {
    if (found.size + pending.length > limits.directories) return failure('budget', 'The runtime dependency closure exceeds its package limit.');
    const name = pending.shift(); if (!name || found.has(name)) continue;
    if (!/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9_.-]*$/u.test(name)) return failure('invalid-args', 'The runtime dependency name is invalid.');
    const entry = packages[`node_modules/${name}`];
    if (!isObject(entry) || typeof entry['integrity'] !== 'string' || typeof entry['version'] !== 'string') return failure('invalid-args', 'The runtime dependency has no exact recorded integrity.');
    const source = await realpath(join(root, 'node_modules', name)); if (source !== join(root, 'node_modules', name)) return failure('outside-roots', 'The runtime dependency is not a canonical vendored directory.');
    const value = await object(join(source, 'package.json')); if (!value.ok) return value;
    if (value.value['name'] !== name || value.value['version'] !== entry['version']) return failure('invalid-args', 'The installed runtime dependency differs from the recorded version.');
    found.set(name, { kind: 'node_modules', directory: name, name: name.replace(/^@/u, ''), source, manifest: value.value, integrity: entry['integrity'] });
    if (isObject(entry['dependencies'])) pending.push(...Object.keys(entry['dependencies']));
  }
  return { ok: true, value: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}
export async function catalog(repository: string): Promise<Result<Source[]>> {
  try {
    const root = await realpath(repository); const result: Source[] = [];
    for (const kind of ['packages', 'lib', 'contracts'] satisfies ('packages' | 'lib' | 'contracts')[]) { const sources = await directory(root, kind); if (!sources.ok) return sources; result.push(...sources.value); }
    const external = await vendors(root); return external.ok ? { ok: true, value: [...result, ...external.value] } : external;
  } catch { return failure('io', 'The review catalog could not be read.'); }
}
