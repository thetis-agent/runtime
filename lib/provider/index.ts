/** Enforce call-time budgets before vendor access; PR-010, ADR 0020. */
import type { RequestEvent, ResponseEvent, DescribeResponse } from '../../contracts/provider/types.ts';
import type { Result } from '../schema/index.ts';
import { failure } from '../schema/index.ts';
import type { BudgetCheckpoint } from './checkpoint.ts';
import { Balance } from './balance.ts';
import { balance, money } from './money.ts';

export interface Rule { name: string; cost: number; requests: number; windowMs: number }
export interface Caller { person: string; scope: 'person' | 'deployment'; cost?: number; expires?: number }
export interface Authority {
  whois(token: string): Promise<Result<Caller, 'auth'>>;
  report(token: string, callId: string, counters: Record<string, number>): Promise<Result<void, 'auth'>>;
}
export type Description = Result<DescribeResponse, Extract<ResponseEvent, { type: 'error' }>['code']>;
export interface Provider {
  describe(): Promise<Description>;
  run(request: AsyncIterable<RequestEvent>, token: string, signal: AbortSignal): AsyncIterable<ResponseEvent>;
}

type Window = { at: number; requests: number; balance: Balance };
type Run = Window & { expires?: number };
type Lifetime = 'person' | 'run';

export class Budgets {
  readonly #people = new Map<string, Window>();
  readonly #runs = new Map<string, Run>();
  readonly rule: Rule;
  readonly now: () => number;
  readonly peopleLimit: number;
  readonly #checkpoint: BudgetCheckpoint | undefined;
  constructor(rule: Rule, now: () => number, peopleLimit = 4096, checkpoint?: BudgetCheckpoint) {
    if (!Number.isFinite(rule.cost) || rule.cost < 0 || !Number.isSafeInteger(rule.requests) || rule.requests < 1 || !Number.isSafeInteger(rule.windowMs) || rule.windowMs < 1 || !Number.isSafeInteger(peopleLimit) || peopleLimit < 1) throw new Error('The provider budget rule is invalid.');
    this.rule = Object.freeze({ ...rule }); this.now = now; this.peopleLimit = peopleLimit;
    this.#checkpoint = checkpoint;
    for (const window of checkpoint?.initial.people ?? []) {
      const expired = this.now() - window.at >= rule.windowMs;
      if (!expired || balance(window.reserved) > 0n) this.#people.set(window.person, { at: expired ? this.now() : window.at, requests: expired ? 0 : window.requests, balance: new Balance(expired ? '0' : window.spent, window.reserved) });
    }
    for (const run of checkpoint?.initial.runs ?? []) {
      if (run.expires === undefined || run.expires > this.now()) this.#runs.set(run.digest, { at: run.at, requests: run.requests, balance: new Balance(run.spent, run.reserved), ...(run.expires === undefined ? {} : { expires: run.expires }) });
    }
  }

  reserve(person: string, maximumCost: number, ceiling = this.rule.cost): Result<(actual: number) => void, 'budget'> {
    this.#reap();
    let window = this.#people.get(person);
    if (!window) {
      if (this.#full()) return failure('budget', `${this.rule.name} has reached its person limit.`);
      window = { at: this.now(), requests: 0, balance: new Balance() };
    }
    this.#refresh(window, 'person');
    const reserved = this.#reserve(window, maximumCost, ceiling, 'person');
    if (reserved.ok) this.#people.set(person, window);
    return reserved;
  }

  reserveRun(digest: string, maximumCost: number, ceiling: number, expires: number): Result<(actual: number) => void, 'budget'> {
    if (!Number.isFinite(expires) || expires <= this.now()) return failure('budget', 'The trusted run retirement deadline is missing or expired.');
    this.#reap();
    let run = this.#runs.get(digest);
    if (run?.expires !== undefined && run.expires !== expires) return failure('budget', 'The trusted run retirement deadline changed.');
    if (!run) {
      if (this.#full()) return failure('budget', `${this.rule.name} has reached its person limit.`);
      run = { at: this.now(), requests: 0, balance: new Balance(), expires };
    }
    run.expires = expires; this.#refresh(run, 'run');
    const reserved = this.#reserve(run, maximumCost, ceiling, 'run');
    if (reserved.ok) this.#runs.set(digest, run);
    return reserved;
  }

  #reserve(window: Window, maximumCost: number, ceiling: number, lifetime: Lifetime): Result<(actual: number) => void, 'budget'> {
    if (!Number.isFinite(maximumCost) || maximumCost < 0 || !Number.isFinite(ceiling) || ceiling < 0) return failure('budget', `${this.rule.name} has no bounded call estimate.`);
    const maximum = money(maximumCost);
    if (window.balance.spent + window.balance.reserved + maximum > money(ceiling) || window.requests >= this.rule.requests) {
      return failure('budget', `${this.rule.name} would be exceeded.`);
    }
    window.requests++;
    const settle = window.balance.reserve(maximum);
    return { ok: true, value: actual => { this.#refresh(window, lifetime); settle(actual); } };
  }

  #refresh(window: Window, lifetime: Lifetime): void {
    if (this.now() - window.at < this.rule.windowMs) return;
    window.at = this.now(); window.requests = 0;
    if (lifetime === 'person') window.balance.spent = 0n;
  }

  #full(): boolean { return this.#people.size + this.#runs.size >= this.peopleLimit; }

  #reap(): void {
    for (const [id, window] of this.#people) if (this.now() - window.at >= this.rule.windowMs && window.balance.active === 0) this.#people.delete(id);
    for (const [id, run] of this.#runs) if (run.expires !== undefined && run.expires <= this.now() && run.balance.active === 0) this.#runs.delete(id);
  }

  checkpoint(): Promise<Result<void>> {
    return this.#checkpoint?.save({ version: 2,
      people: [...this.#people].map(([person, window]) => ({ person, at: window.at, requests: window.requests, ...window.balance.snapshot() })),
      runs: [...this.#runs].map(([digest, run]) => ({ digest, at: run.at, requests: run.requests, ...run.balance.snapshot(), ...(run.expires === undefined ? {} : { expires: run.expires }) }))
    }) ?? Promise.resolve({ ok: true, value: undefined });
  }
}

export function* events(items: readonly RequestEvent[]): Generator<RequestEvent> {
  for (const item of items) yield item;
}
