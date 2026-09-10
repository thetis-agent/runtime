/** Discover immutable directories and validate settings before evaluation; ADR 0016, TE-021–022. */
import { readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Validator as ValidateFunction } from '../schema/index.ts';
import { failure, isObject } from '../schema/index.ts';
import type { Schemas, Result } from '../schema/index.ts';
import { resolvePath } from '../files/index.ts';
import { readBounded } from '../files/read-bounded.ts';
import { matches, gap } from '../semver-match/index.ts';
import { configured } from '../schema/settings.ts';
import type { Entry, Manifest } from './types.ts';

export const limits = { packages: 256, manifestBytes: 65536, messageBytes: 65536, messages: 256, probeMs: 10000 };

let protocol: Promise<Record<string, unknown>> | undefined;
async function protocolSchema(): Promise<Record<string, unknown>> {
  const raw: unknown = JSON.parse(await readFile(new URL('./schema.json', import.meta.url), 'utf8'));
  if (!isObject(raw)) throw new Error('The committed package protocol schema is invalid.');
  return raw;
}
export async function validator<T>(schemas: Schemas, definition: string): Promise<ValidateFunction<T>> {
  protocol ??= protocolSchema();
  return schemas.definition<T>(await protocol, definition);
}

export async function discover(root: string, state: string, settings: Readonly<Record<string, Record<string, unknown>>>, schemas: Schemas): Promise<Result<Entry[]>> {
  try {
    const canonical = await realpath(root); const names = await readdir(canonical, { withFileTypes: true }); const entries: Entry[] = [];
    if (names.length > limits.packages) return failure('budget', 'The package directory exceeds its entry limit.');
    const check = await validator<Manifest>(schemas, 'manifest');
    for (const entry of names.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith('.') || entry.isFile()) continue;
      const name = entry.name;
      const directory = await resolvePath(name, [{ path: canonical, mode: 'ro', space: 'package' }]); if (!directory.ok) return directory;
      const roots = [{ path: directory.value, mode: 'ro', space: 'package' } satisfies { path: string; mode: 'ro'; space: string }];
      const path = await resolvePath('package.json', roots); if (!path.ok) return path;
      const raw = await readBounded(path.value, limits.manifestBytes); if (!raw.ok) return raw;
      const manifest: unknown = JSON.parse(raw.value.toString('utf8'));
      if (!check(manifest) || !matches(manifest.version, '*')) return failure('invalid-args', `${name} has an invalid package manifest.`);
      if (entries.some(entry => entry.manifest.name === manifest.name)) return failure('collision', `${manifest.name} occurs in more than one package directory.`);
      const module = await resolvePath('index.ts', roots); if (!module.ok) return module;
      const values = configured(manifest.settings, settings[manifest.name] ?? {});
      if (!schemas.arguments(manifest.settings, values)) return failure('gap', gap(manifest, `setting/${manifest.name}`, '*'));
      entries.push({ path: module.value, manifest, settings: values, state: join(state, createHash('sha256').update(manifest.name).digest('hex')) });
    }
    return { ok: true, value: entries };
  } catch { return failure('io', 'The package directory or its manifests could not be read.'); }
}
