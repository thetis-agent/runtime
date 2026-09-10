/** Relocate host references without rewriting immutable journal or snapshot identities; GN-007, ADR 0030. */
import { lstat } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { readBounded } from '../files/read-bounded.ts';
import { failure, isObject } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';
import type { Checkpoint } from './checkpoint.ts';

export interface Relocation { from: string; to: string }
export const relocationLimits = { entries: 8, bytes: 65536, pathBytes: 4096 };
export async function relocations(root: string): Promise<Result<Relocation[]>> {
  const path = join(root, '.relocation.json');
  try { if (!(await lstat(path)).isFile()) return failure('outside-roots', 'The relocation metadata is not a regular file.'); }
  catch (error) { if (isObject(error) && error['code'] === 'ENOENT') return { ok: true, value: [] }; return failure('io', 'The relocation metadata cannot be inspected.'); }
  const bytes = await readBounded(path, relocationLimits.bytes); if (!bytes.ok) return bytes;
  let value: unknown; try { value = JSON.parse(bytes.value.toString('utf8')); } catch { return failure('invalid-args', 'The relocation metadata is invalid JSON.'); }
  if (!Array.isArray(value) || value.length > relocationLimits.entries) return failure('budget', 'The relocation metadata exceeds its entry budget.');
  const mappings: Relocation[] = [];
  for (const item of value) {
    if (!isObject(item) || typeof item['from'] !== 'string' || typeof item['to'] !== 'string' || ![item['from'], item['to']].every(path => isAbsolute(path) && resolve(path) === path && path !== '/' && Buffer.byteLength(path) <= relocationLimits.pathBytes)) return failure('invalid-args', 'The relocation roots are invalid.');
    mappings.push({ from: item['from'], to: item['to'] });
  }
  return { ok: true, value: mappings };
}

export function relocate(value: Checkpoint, mappings: readonly Relocation[]): Checkpoint {
  const path = (value: string): string => mappings.reduce((current, mapping) => current === mapping.from || current.startsWith(`${mapping.from}/`) ? `${mapping.to}${current.slice(mapping.from.length)}` : current, value);
  const pins = (values: Checkpoint['pins']): Checkpoint['pins'] => Object.fromEntries(Object.entries(values).map(([name, pin]) => [name, { ...pin, source: path(pin.source) }]));
  return { ...value, state: path(value.state), endpoint: path(value.endpoint), pins: pins(value.pins), target: { ...value.target, state: path(value.target.state), revision: { ...value.target.revision,
    pins: pins(value.target.revision.pins), mounts: value.target.revision.mounts.map(mount => ({ ...mount, source: path(mount.source) })) } } };
}

export async function relocateCheckpoint(root: string, value: Checkpoint): Promise<Result<Checkpoint>> {
  const mappings = await relocations(root); return mappings.ok ? { ok: true, value: relocate(value, mappings.value) } : mappings;
}
