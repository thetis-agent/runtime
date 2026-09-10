/** Bind a supervised kernel revision to the tree hashes its release published, never to hashes it computed for itself; ADR 0048, GN-002. */
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { readBounded } from '@/lib/files/read-bounded.ts';
import { snapshot } from '@/lib/snapshots/index.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Result, Schemas } from '@/lib/schema/index.ts';
import type { Deployment } from '@/lib/deployment/types.ts';
import type { Revision } from './prepare.ts';
import schema from './schema.json' with { type: 'json' };
import type { Pins } from './types.ts';

export const pinLimits = { manifestBytes: 65536 };
export const pinManifest = 'kernel-pins.json';
const inside = (path: string): boolean => path !== '' && path !== '..' && !path.startsWith('../') && !isAbsolute(path);

export async function readKernelPins(release: string, schemas: Schemas): Promise<Result<Pins>> {
  const bytes = await readBounded(join(release, pinManifest), pinLimits.manifestBytes); if (!bytes.ok) return bytes;
  let value: unknown;
  try { value = JSON.parse(bytes.value.toString('utf8')); } catch { return failure('invalid-args', 'The release kernel pin manifest is not valid JSON.'); }
  const check = schemas.compile<Pins>({ ...schema, $id: 'thetis://internal/maintenance/pins', $ref: '#/$defs/pins' });
  return check(value) && inside(value.entry) ? { ok: true, value } : failure('invalid-args', 'The release kernel pin manifest is not a bounded relative entry with hashed pins.');
}

export async function kernelRevision(release: string, configuration: Deployment, schemas: Schemas): Promise<Result<Revision>> {
  const manifest = await readKernelPins(release, schemas); if (!manifest.ok) return manifest;
  const pins: Record<string, { source: string; hash: string }> = {};
  try {
    const root = await realpath(release);
    for (const [name, hash] of Object.entries(manifest.value.pins)) {
      const source = join(root, name);
      if (!inside(name) || !inside(relative(root, source)) || await realpath(source) !== source) return failure('outside-roots', `The published kernel pin ${name} is not a canonical directory inside its release.`);
      const measured = await snapshot(source); if (!measured.ok) return measured;
      if (measured.value !== hash) return failure('hash-mismatch', `The installed ${name} tree does not match the hash this release published.`);
      pins[name] = { source, hash };
    }
  } catch { return failure('io', 'The release kernel pin directories could not be inspected.'); }
  return { ok: true, value: { pins, entry: manifest.value.entry, configuration } };
}
