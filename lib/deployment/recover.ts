/** Bind durable revision metadata to observed epochs before restoring authority; ADR 0030. */
import { hasCheckpoint, loadCheckpoint } from './checkpoint.ts';
import type { Checkpoint } from './checkpoint.ts';
import { recover } from '@/lib/generation-state/index.ts';
import type { View } from '@/lib/generation-state/types.ts';
import { validator } from '@/lib/package-loader/index.ts';
import type { Entry } from '@/lib/package-loader/types.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Result, Schemas } from '@/lib/schema/index.ts';
import type { ConfiguredTarget } from './index.ts';

export interface Recovery { checkpoint: Checkpoint; target: ConfiguredTarget; view: View }
export async function recovery(root: string, journal: string, target: string, schemas: Schemas): Promise<Result<Recovery | undefined>> {
  const exists = await hasCheckpoint(root, target); if (!exists.ok) return exists;
  const observed = await recover(journal, target, schemas); if (!observed.ok) return observed;
  if (!exists.value) return observed.value ? failure('io', 'The observed generation has no recovery checkpoint.') : { ok: true, value: undefined };
  const saved = await loadCheckpoint(root, target, schemas); if (!saved.ok) return saved;
  const view = observed.value;
  if (!view || view.state === 'FAILED') return failure('io', 'The target has no recoverable observed generation; reset is required.');
  const pins = saved.value.pins;
  if (saved.value.view.current.n !== view.current.n || Object.keys(pins).length !== Object.keys(view.current.pins).length || Object.entries(pins).some(([name, pin]) => pin.hash !== view.current.pins[name])) return failure('fenced', 'The recovery checkpoint does not match the observed generation pins.');
  const check = await validator<Entry>(schemas, 'entry'); const entries: Entry[] = [];
  for (const entry of saved.value.target.entries) { if (!check(entry)) return failure('invalid-args', 'The recovered package entry violates its schema.'); entries.push(entry); }
  return { ok: true, value: { checkpoint: saved.value, target: { ...saved.value.target, entries, revision: { ...saved.value.target.revision, pins } }, view } };
}
