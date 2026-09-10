/** Verify pins and migrate only an isolated state copy before probing; GN-002, GN-006. */
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { verify } from '../../lib/snapshots/index.ts';
import { retainPin } from '../../lib/snapshots/pins.ts';
import { activeRuns } from '../../lib/snapshots/retention.ts';
import type { SnapshotStore } from '../../lib/snapshots/store.ts';
import { formats } from '../../lib/files/formats.ts';
import { command } from '../../lib/sandbox-runner/command.ts';
import type { Plan, Mount } from '../../lib/sandbox-runner/index.ts';
import type { Context } from '../boundary/process.ts';
import { failure } from '../../lib/schema/index.ts';
import type { Result } from '../../lib/schema/index.ts';

export interface Revision {
  plan: Omit<Plan, 'socket' | 'token' | 'mounts'>;
  pins: Readonly<Record<string, { source: string; hash: string; mount: string }>>;
  mounts: readonly Mount[];
  stateMount: string; endpointMount: string; socketName: string; quotaBytes: number;
  formats: readonly { path: string; schema: Record<string, unknown> }[];
  migrations: readonly { entry: string; args: readonly string[] }[];
  migrate: 'stop' | 'shared';
}
export interface Prepared { root: string; state: string; endpoint: string; plan: Omit<Plan, 'socket' | 'token'>; pins: Revision['pins'] }
export const limits = { pins: 256, formats: 256, migrations: 64, formatBytes: 1024 * 1024, generations: 128 };

export async function prepare(root: string, revision: Revision, stateHash: string, store: SnapshotStore, token: string, context: Context, retained: Revision['pins'] = {}): Promise<Result<Prepared>> {
  if (Object.keys(revision.pins).length > limits.pins || revision.formats.length > limits.formats || revision.migrations.length > limits.migrations || !/^[a-zA-Z0-9_-]+\.sock$/u.test(revision.socketName)) return failure('budget', 'The generation plan exceeds its preparation limits.');
  if (!bound(revision)) return failure('outside-roots', 'The generation entry or writable grants are outside its verified mount plan.');
  const state = join(root, 'state'); const endpoint = join(root, 'endpoint');
  try {
    const active = await activeRuns(dirname(root)); if (!active.ok) return active;
    if (active.value >= limits.generations) return failure('budget', 'The active generation pool is full.');
    await mkdir(endpoint, { recursive: true, mode: 0o700 });
    const restored = await store.restore(stateHash, state); if (!restored.ok) return restored;
    const mounts: Mount[] = revision.mounts.map(mount => ({ ...mount, mode: 'ro' }));
    const pins: Record<string, { source: string; hash: string; mount: string }> = {};
    for (const [name, pin] of Object.entries(revision.pins)) {
      const existing = retained[name];
      if (existing?.hash === pin.hash && existing.mount === pin.mount) {
        if (revision.plan.execution === 'artifacts') { const checked = await verify(existing.source); if (!checked.ok) return checked; }
        mounts.push({ source: existing.source, path: pin.mount, mode: 'ro' }); pins[name] = existing; continue;
      }
      const copied = await retainPin(join(dirname(dirname(root)), 'pins'), pin.source, pin.hash, revision.plan.execution === 'artifacts'); if (!copied.ok) return copied;
      const destination = copied.value;
      mounts.push({ source: destination, path: pin.mount, mode: 'ro' });
      pins[name] = { ...pin, source: destination };
    }
    mounts.push({ source: state, path: revision.stateMount, mode: 'rw', maximumBytes: revision.quotaBytes }, { source: endpoint, path: revision.endpointMount, mode: 'rw', maximumBytes: revision.quotaBytes });
    const plan = { ...revision.plan, mounts };
    for (const migration of revision.migrations) {
      const migrated = await command(context.runner, { ...plan, ...migration, token }, context.clock);
      const observed = await context.journal.observed(context.target, 'migration.exit', migrated.ok ? { ...migrated.value } : { error: migrated.error }); if (!observed.ok) return observed;
      if (!migrated.ok) return migrated; if (migrated.value.code !== 0) return failure('io', 'The state migration did not exit successfully.');
    }
    const valid = await formats(state, revision.formats, context.schemas, limits.formatBytes); if (!valid.ok) return valid;
    return { ok: true, value: { root, state, endpoint: join(endpoint, revision.socketName), plan, pins } };
  } catch { return failure('io', 'The isolated generation could not be prepared.'); }
}

function bound(revision: Revision): boolean {
  const contains = (root: string, path: string): boolean => path === root || path.startsWith(`${root}/`);
  const pinned = Object.values(revision.pins).map(pin => resolve(pin.mount));
  if (![revision.plan.entry, revision.stateMount, revision.endpointMount, ...Object.values(revision.pins).map(pin => pin.mount)].every(isAbsolute)) return false;
  for (const entry of [revision.plan.entry, ...revision.migrations.map(migration => migration.entry)]) if (!isAbsolute(entry) || !pinned.some(root => contains(root, resolve(entry)))) return false;
  const writable = [resolve(revision.stateMount), resolve(revision.endpointMount)];
  for (const [index, path] of writable.entries()) {
    const others = [...pinned, ...revision.mounts.map(mount => resolve(mount.path)), ...writable.slice(index + 1)];
    if (others.some(other => contains(path, other) || contains(other, path))) return false;
  }
  return true;
}

export function serving(prepared: Prepared, revision: Revision): Omit<Plan, 'socket' | 'token'> {
  return { ...prepared.plan, mounts: prepared.plan.mounts.map(mount => revision.mounts.find(shared => shared.path === mount.path) ?? mount) };
}

export async function discard(root: string): Promise<Result<void>> {
  try { await rm(root, { recursive: true, force: true }); return { ok: true, value: undefined }; }
  catch { return failure('io', 'The isolated generation could not be removed.'); }
}
