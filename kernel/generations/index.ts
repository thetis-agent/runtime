/** Serialize guarded transitions and persist every observation before exposing state; ADR 0012, GN-001–007. */
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import type { Journal } from '@/kernel/log/index.ts';
import { transitions } from '@/kernel/generations/table.ts';
import type { Event, Guard } from '@/kernel/generations/table.ts';

import { project } from '@/lib/generation-state/projection.ts';
import type { Generation, View } from '@/lib/generation-state/projection.ts';
export type { Generation, View } from '@/lib/generation-state/projection.ts';
export interface Input {
  event: Event; reason: string; candidate?: Generation; baseline?: number; authorized?: boolean;
  active?: number; snapshot?: string; snapshotVerified?: boolean; pinsVerified?: boolean;
  migrationsPassed?: boolean; formatValid?: boolean; clientCompatible?: boolean;
  atomic?: boolean; connections?: number; restored?: boolean; probed?: boolean; stop?: boolean;
  exited?: boolean;
}
export const deadlines = { drain: 30000, probe: 10000, oldDrain: 60000 };
type Code = 'switching' | 'baseline-moved' | 'forbidden' | 'invalid-args' | 'budget' | 'io';

export class Generations {
  #view: View;
  #busy = false;
  readonly #target: string;
  readonly #journal: Journal;
  readonly #now: () => number;
  readonly #limits: typeof deadlines;
  constructor(target: string, initial: Generation, journal: Journal, now: () => number, settings = deadlines, recovered?: View) {
    this.#target = target; this.#journal = journal; this.#now = now; this.#limits = settings;
    this.#view = recovered ? structuredClone(recovered) : { state: 'LIVE', current: structuredClone(initial), since: now() };
  }

  get view(): View { return structuredClone(this.#view); }
  get admits(): boolean { return !this.#busy && this.#view.state === 'LIVE'; }

  async transition(input: Input): Promise<Result<readonly string[], Code>> {
    if (input.baseline !== undefined && input.baseline !== this.#view.current.n) return failure('baseline-moved', `The baseline is now ${String(this.#view.current.n)}; prepare again.`);
    if (this.#busy) return failure('switching', 'The target is already switching.');
    const row = transitions.find(row => row.from === this.#view.state && row.event === input.event && (row.stop === undefined || row.stop === (input.stop ?? false)));
    if (!row) return failure(input.event === 'switch' || input.event === 'undo' ? 'switching' : 'invalid-args', `The target in ${this.#view.state} cannot accept ${input.event}.`);
    const allowed = this.#guard(row.guard, input);
    if (!allowed.ok) return allowed;
    const before = this.#view; const now = this.#now();
    const next = project(this.#view, row.to, input, now);
    this.#busy = true;
    try {
      const written = await this.#journal.observed(this.#target, 'generation.transition', { from: before.state, to: row.to, event: input.event, reason: input.reason, elapsedMs: now - before.since, generation: next.current.n, snapshot: next }, row.to === 'ROLLING_BACK' || row.to === 'FAILED');
      if (!written.ok) return written;
      this.#view = next;
      return { ok: true, value: [...row.effects] };
    } finally { this.#busy = false; }
  }

  #guard(guard: Guard, input: Input): Result<void, Code> {
    const elapsed = this.#now() - this.#view.since;
    let valid: boolean;
    switch (guard) {
      case 'authorized': valid = input.authorized === true && input.candidate !== undefined; break;
      case 'undoable': valid = input.authorized === true && this.#view.previous !== undefined; break;
      case 'drained': valid = input.active === 0 || elapsed >= this.#limits.drain; break;
      case 'snapshot': valid = input.snapshotVerified === true && !!input.snapshot; break;
      case 'applied': valid = input.pinsVerified === true && input.migrationsPassed === true && input.formatValid === true; break;
      case 'healthy': valid = input.probed === true && input.clientCompatible === true && elapsed < this.#limits.probe; break;
      case 'atomic': valid = input.atomic === true && this.#view.committed === true; break;
      case 'closed': valid = input.connections === 0 || elapsed >= this.#limits.oldDrain; break;
      case 'restored': valid = input.restored === true && input.probed === true && (!input.candidate || JSON.stringify(input.candidate) === JSON.stringify(this.#view.candidate)); break;
      case 'exited': valid = input.exited === true; break;
      case 'recovery': valid = input.authorized === true && input.candidate?.n === Math.max(this.#view.current.n, this.#view.candidate?.n ?? 0) + 1 && input.candidate.stateSnapshot === this.#view.current.stateSnapshot && JSON.stringify(input.candidate.pins) === JSON.stringify(this.#view.current.pins); break;
      case 'always': valid = true; break;
    }
    return valid ? { ok: true, value: undefined } : failure(guard === 'authorized' || guard === 'undoable' ? 'forbidden' : 'invalid-args', `The ${guard} guard refused ${input.event}.`);
  }

}
