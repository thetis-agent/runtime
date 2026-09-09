/** Serialize guarded transitions and persist every observation before exposing state; ADR 0012, GN-001–007. */
import { failure } from '../../lib/schema/index.ts';
import type { Result } from '../../lib/schema/index.ts';
import type { Journal } from '../log/index.ts';
import { transitions } from './table.ts';
import type { State, Event, Guard } from './table.ts';

export interface Generation { n: number; pins: Readonly<Record<string, string>>; stateSnapshot: string; prefixRenderer: string; at: number }
export interface View { state: State; current: Generation; candidate?: Generation; previous?: Generation; committed?: boolean; since: number }
export interface Input {
  event: Event; reason: string; candidate?: Generation; baseline?: number; authorized?: boolean;
  active?: number; snapshot?: string; snapshotVerified?: boolean; pinsVerified?: boolean;
  migrationsPassed?: boolean; formatValid?: boolean; clientCompatible?: boolean;
  atomic?: boolean; connections?: number; restored?: boolean; probed?: boolean; stop?: boolean;
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
  constructor(target: string, initial: Generation, journal: Journal, now: () => number, settings = deadlines) {
    this.#target = target; this.#journal = journal; this.#now = now; this.#limits = settings;
    this.#view = { state: 'LIVE', current: structuredClone(initial), since: now() };
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
    const next = this.#next(row.to, input, now);
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
      case 'atomic': valid = input.atomic === true; break;
      case 'closed': valid = input.connections === 0 || elapsed >= this.#limits.oldDrain; break;
      case 'restored': valid = input.restored === true && input.probed === true; break;
      case 'always': valid = true; break;
    }
    return valid ? { ok: true, value: undefined } : failure(guard === 'authorized' || guard === 'undoable' ? 'forbidden' : 'invalid-args', `The ${guard} guard refused ${input.event}.`);
  }

  #next(state: State, input: Input, now: number): View {
    const next: View = { ...structuredClone(this.#view), state, since: now };
    if (input.event === 'switch' && input.candidate) next.candidate = { ...structuredClone(input.candidate), n: next.current.n + 1 };
    if (input.event === 'undo' && next.previous) next.candidate = { ...next.previous, n: next.current.n + 1 };
    if (input.event === 'snapshot' && input.snapshot) next.current.stateSnapshot = input.snapshot;
    if (input.event === 'repointed') next.committed = true;
    if ((input.event === 'closed' || input.event === 'repointed' && input.stop) && next.candidate) {
      next.previous = next.current; next.current = { ...next.candidate, at: now }; delete next.candidate; delete next.committed;
    }
    if (input.event === 'restored') {
      if (next.committed) next.current = { ...next.current, n: Math.max(next.current.n, next.candidate?.n ?? 0) + 1, at: now };
      delete next.candidate; delete next.committed;
    }
    return next;
  }
}
