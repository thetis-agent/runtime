/** Recover serving code and stores only from canonical retained runs and observed epochs; implementation note 0052, GN-007. */
import { lstat, realpath, readdir, rm, symlink, rename } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite, syncDirectory } from '@/lib/files/atomic.ts';
import { readBounded } from '@/lib/files/read-bounded.ts';
import { configuration } from '@/lib/deployment/index.ts';
import { recover } from '@/lib/generation-state/index.ts';
import type { View } from '@/lib/generation-state/projection.ts';
import { snapshot } from '@/lib/snapshots/index.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Result, Schemas } from '@/lib/schema/index.ts';
import type { Prepared, Revision } from './prepare.ts';

export const checkpointLimits = { bytes: 262144, entries: 512 };
export interface Retained { n: number; prepared: Prepared; entry: string; pins: Readonly<Record<string, string>>; release?: string }
export interface Checkpoint { version: 1; live: Retained; previous?: Retained; next?: Retained }
export interface Recovered { saved: Checkpoint; view: View; live: Retained; previous?: Retained; revision: Revision }
const path = { type: 'string', minLength: 1, maxLength: 4096 } as const;
const retainedSchema = {
  type: 'object', required: ['n', 'prepared', 'entry', 'pins'], properties: {
    n: { type: 'integer', minimum: 1 }, entry: path, release: path,
    pins: { type: 'object', minProperties: 1, maxProperties: 256, additionalProperties: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' } },
    prepared: { type: 'object', required: ['root', 'entry', 'state', 'configuration', 'endpoint', 'hash'],
      properties: Object.fromEntries(['root', 'entry', 'state', 'configuration', 'endpoint', 'hash'].map(name => [name, path])) },
  },
} as const;

export const hashes = (revision: Revision): Record<string, string> => Object.fromEntries(Object.entries(revision.pins).map(([name, pin]) => [name, pin.hash]));
export function retained(n: number, prepared: Prepared, revision: Revision): Retained {
  return { n, prepared, entry: revision.entry, pins: hashes(revision), ...revision.release ? { release: revision.release } : {} };
}

export async function save(root: string, saved: Checkpoint): Promise<Result<void>> {
  const bytes = Buffer.from(`${JSON.stringify(saved)}\n`);
  return bytes.length <= checkpointLimits.bytes ? atomicWrite(join(root, 'serving.json'), bytes) : failure('budget', 'The maintenance checkpoint exceeds its byte budget.');
}

async function canonicalChild(root: string, path: string): Promise<boolean> {
  const child = relative(root, path);
  return child.length > 0 && !child.startsWith('..') && !child.startsWith('/') && await realpath(path).catch(() => '') === path;
}

export async function revisionOf(run: Retained, root: string, stores: string | undefined, schemas: Schemas): Promise<Result<Revision>> {
  const prepared = run.prepared;
  if (!await canonicalChild(join(root, 'runs'), prepared.root) || !await canonicalChild(stores ?? prepared.root, prepared.state) ||
    prepared.configuration !== join(prepared.root, 'configuration.json') || prepared.endpoint !== join(prepared.root, 'kernel.sock')) {
    return failure('outside-roots', 'The maintenance checkpoint names a run or store outside its managed roots.');
  }
  const config = await configuration(prepared.configuration, schemas); if (!config.ok) return config;
  if (config.value.root !== prepared.state) return failure('conflict', 'The retained kernel configuration names a different store.');
  const pins: Record<string, { source: string; hash: string }> = {};
  const code = join(prepared.root, 'code');
  for (const [name, hash] of Object.entries(run.pins)) {
    const source = join(code, name);
    if (!await canonicalChild(code, source)) return failure('outside-roots', 'A retained kernel pin escapes its run.');
    const measured = await snapshot(source); if (!measured.ok) return measured;
    if (measured.value !== hash) return failure('hash-mismatch', 'A retained kernel pin differs from the observed release.');
    pins[name] = { source, hash };
  }
  if (prepared.entry !== join(code, run.entry) || !await canonicalChild(code, prepared.entry)) return failure('outside-roots', 'The retained entry escapes its code pins.');
  return { ok: true, value: { pins, entry: run.entry, configuration: config.value, ...run.release ? { release: run.release } : {} } };
}

function samePins(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  return Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([key, value]) => right[key] === value);
}

export async function load(root: string, stores: string | undefined, schemas: Schemas): Promise<Result<Recovered | undefined>> {
  const present = await lstat(join(root, 'serving.json')).catch(() => undefined);
  const observed = await recover(join(root, 'observed.jsonl'), 'kernel', schemas); if (!observed.ok) return observed;
  if (!present) return observed.value ? failure('io', 'The observed kernel history has no serving checkpoint; restore its retained metadata.') : { ok: true, value: undefined };
  const bytes = await readBounded(join(root, 'serving.json'), checkpointLimits.bytes); if (!bytes.ok) return bytes;
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.value.toString('utf8')); } catch { return failure('invalid-args', 'The maintenance checkpoint is not valid JSON.'); }
  const check = schemas.compile<Checkpoint>({ type: 'object', required: ['version', 'live'], properties: {
    version: { const: 1 }, live: retainedSchema, previous: retainedSchema, next: retainedSchema,
  } });
  if (!check(parsed) || !observed.value) return failure('invalid-args', 'The maintenance checkpoint has no valid observed generation.');
  const view = observed.value;
  const promoted = view.state === 'LIVE' && parsed.next?.n === view.current.n;
  const live = promoted && parsed.next ? parsed.next : parsed.live;
  if (!samePins(live.pins, view.current.pins)) return failure('hash-mismatch', 'The serving checkpoint differs from the observed kernel pins.');
  const previous = promoted ? parsed.live : parsed.previous;
  const revision = await revisionOf(live, root, stores, schemas); if (!revision.ok) return revision;
  return { ok: true, value: { saved: parsed, view, live, ...previous ? { previous } : {}, revision: revision.value } };
}

/** A synced host alias lets a proxy keep its socket paths across kernel generations. */
export async function publish(root: string, state: string): Promise<Result<void>> {
  const pending = join(root, `.live-${randomUUID()}`);
  try {
    if (!await canonicalChild(join(root, 'g'), state)) return failure('outside-roots', 'The public alias must name a managed generation store.');
    await symlink(relative(root, state), pending); await rename(pending, join(root, 'live'));
    return await syncDirectory(root);
  } catch { await rm(pending, { force: true }); return failure('io', 'The stable public socket alias could not be published.'); }
}

/** Called only while the maintenance transaction exclusion is held. */
export async function retire(root: string, stores: string | undefined, kept: readonly Retained[]): Promise<Result<number>> {
  let removed = 0;
  for (const directory of [join(root, 'runs'), ...stores ? [stores] : [], root]) {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > checkpointLimits.entries) return failure('budget', 'Maintenance retention exceeds its directory budget.');
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const managed = directory === root ? /^snapshot-[0-9]+-[a-f0-9-]+$/u.test(entry.name)
        : directory === stores ? /^[gr][0-9]+-[a-f0-9]{8}$/u.test(entry.name) : /^(?:[0-9]+|[0-9]+-[a-f0-9-]+|recovery-[a-f0-9-]+)$/u.test(entry.name);
      if (!managed || kept.some(run => run.prepared.root === path || run.prepared.state === path)) continue;
      if (!entry.isDirectory() || !await canonicalChild(directory, path)) return failure('outside-roots', 'A retired maintenance entry is not a canonical directory.');
      await rm(path, { recursive: true }); removed++;
    }
  }
  return { ok: true, value: removed };
}
