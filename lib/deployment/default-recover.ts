/** Recover an interrupted default from its frozen member manifest, never mixed latest targets; ADR 0030, GN-005. */
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { recover } from '@/lib/generation-state/index.ts';
import type { View } from '@/lib/generation-state/types.ts';
import { SnapshotStore } from '@/lib/snapshots/store.ts';
import { readBounded } from '@/lib/files/read-bounded.ts';
import { relocateCheckpoint } from './relocation.ts';
import { checkpointValidator } from './checkpoint.ts';
import { validator } from '@/lib/package-loader/index.ts';
import type { Entry } from '@/lib/package-loader/types.ts';
import type { Recovery } from './recover.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Result, Schemas } from '@/lib/schema/index.ts';
export interface DefaultRecovery { view?: View; targets: Recovery[] }
export async function defaultRecovery(root: string, journal: string, schemas: Schemas): Promise<Result<DefaultRecovery>> {
  const observed = await recover(journal, 'default', schemas); if (!observed.ok) return observed;
  if (!observed.value) return { ok: true, value: { targets: [] } };
  const view = observed.value;
  if (view.state === 'FAILED') return failure('io', 'The failed default requires a reviewed recovery decision.');
  if (['LIVE', 'QUIESCING', 'FROZEN'].includes(view.state)) return { ok: true, value: { view, targets: [] } };
  const directory = await mkdtemp(join(root, 'recovery-'));
  try {
    const destination = join(directory, 'snapshot'); const restored = await new SnapshotStore(join(root, 'snapshots')).restore(view.current.stateSnapshot, destination); if (!restored.ok) return restored;
    const bytes = await readBounded(join(destination, 'manifest.json'), 1048576); if (!bytes.ok) return bytes;
    const input: unknown = JSON.parse(bytes.value.toString('utf8'));
    if (!isObject(input) || !isObject(input['targets']) || Object.keys(input['targets']).length > 64) return failure('invalid-args', 'The frozen default manifest is invalid.');
    const targets = await members(input['targets'], journal, schemas, resolve(root, '..')); return targets.ok ? { ok: true, value: { view, targets: targets.value } } : targets;
  } catch { return failure('io', 'The frozen default manifest could not be recovered.'); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
async function members(input: Record<string, unknown>, journal: string, schemas: Schemas, root: string): Promise<Result<Recovery[]>> {
  const check = await checkpointValidator(schemas); const entryCheck = await validator<Entry>(schemas, 'entry'); const targets: Recovery[] = [];
  for (const [id, retained] of Object.entries(input)) {
    if (!check(retained) || retained.target.id !== id || retained.target.scope !== 'deployment' || Object.entries(retained.pins).some(([name, pin]) => pin.hash !== retained.view.current.pins[name])) return failure('invalid-args', 'The frozen default checkpoint violates its target or pin identity.');
    const relocated = await relocateCheckpoint(root, retained); if (!relocated.ok) return relocated; const checkpoint = relocated.value;
    const latest = await recover(journal, id, schemas); if (!latest.ok) return latest;
    if (!latest.value || latest.value.state === 'FAILED') return failure('io', 'A default member has no recoverable observed generation.');
    const entries: Entry[] = [];
    for (const entry of checkpoint.target.entries) { if (!entryCheck(entry)) return failure('invalid-args', 'The frozen default package entry is invalid.'); entries.push(entry); }
    targets.push({ checkpoint, view: latest.value, target: { ...checkpoint.target, entries, revision: { ...checkpoint.target.revision, pins: checkpoint.pins } } });
  }
  return { ok: true, value: targets };
}
