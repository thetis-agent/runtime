/** Attribute reports only through recorded caller grants and enforce the cost backstop; KS-012–013, ADR 0020. */
import type { UsageReportParams } from '../../contracts/kernel-socket/types.ts';
import { failure } from '../../lib/schema/index.ts';
import type { Result } from '../../lib/schema/index.ts';
import type { Identity, Run } from '../identity/index.ts';
import type { Journal } from '../log/index.ts';

export const limits = { people: 4096, queuedReports: 256, counters: 256, identifierBytes: 256, cost: 100, windowMs: 86400000 };
export class Usage {
  readonly #identity: Identity;
  readonly #journal: Journal;
  readonly #now: () => number;
  readonly #limits: typeof limits;
  readonly #charged = new Map<string, { at: number; cost: number }>();
  #failed = false;
  #queued = 0;
  constructor(identity: Identity, journal: Journal, now: () => number, settings = limits) {
    this.#identity = identity; this.#journal = journal; this.#now = now; this.#limits = settings;
  }

  report(source: Run, params: UsageReportParams): Promise<Result<void>> {
    const caller = this.#identity.authenticate(params.runToken); if (!caller.ok) return Promise.resolve(caller);
    if (source.scope === 'person' ? source.id !== caller.value.id : !caller.value.services.includes(source.id)) return Promise.resolve(failure('auth', 'The report does not name a recorded caller of this run.'));
    if (!Number.isFinite(params.counters.cost) || params.counters.cost < 0 || Object.keys(params.counters).length > this.#limits.counters || Buffer.byteLength(params.callId) > this.#limits.identifierBytes) return Promise.resolve(failure('invalid-args', 'The usage report exceeds its valid attribution shape.'));
    this.#reap();
    if (this.#queued >= this.#limits.queuedReports || !this.#charged.has(caller.value.person) && this.#charged.size >= this.#limits.people) return Promise.resolve(failure('budget', 'The usage attribution pool is full.'));
    if (source.scope === 'deployment' && !this.#charged.has(caller.value.person)) this.#charged.set(caller.value.person, { at: this.#now(), cost: 0 });
    const value = structuredClone(params); const reporter = structuredClone(source);
    this.#queued++;
    return this.#record(reporter, caller.value, value).finally(() => { this.#queued--; });
  }

  allowMount(person: string): Result<void> {
    if (this.#failed) return failure('io', 'Usage attribution failed; new mounts are refused.');
    const charged = this.#charged.get(person);
    return charged && this.#now() - charged.at < this.#limits.windowMs && charged.cost >= this.#limits.cost
      ? failure('budget', 'The cost budget would be exceeded by a new mount.') : { ok: true, value: undefined };
  }

  async #record(source: Run, caller: Run, params: UsageReportParams): Promise<Result<void>> {
    const written = await this.#journal.reported(caller.target, 'usage.report', { source: source.id, person: caller.person, generation: caller.generation, callId: params.callId, counters: params.counters }, source.scope === 'deployment');
    if (!written.ok) { this.#failed = true; return written; }
    if (source.scope === 'deployment') {
      const previous = this.#charged.get(caller.person);
      if (!previous && this.#charged.size >= this.#limits.people) { this.#failed = true; return failure('budget', 'The usage attribution pool is full.'); }
      const current = previous && this.#now() - previous.at < this.#limits.windowMs ? previous : { at: this.#now(), cost: 0 };
      current.cost += params.counters.cost; this.#charged.set(caller.person, current);
    }
    return { ok: true, value: undefined };
  }

  #reap(): void {
    const before = this.#now() - this.#limits.windowMs;
    for (const [person, charged] of this.#charged) if (charged.at <= before) this.#charged.delete(person);
  }
}
