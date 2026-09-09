/** Enforce call-time budgets before vendor access; PR-010, ADR 0020. */
import type { RequestEvent, ResponseEvent, DescribeResponse } from '../../contracts/provider/types.ts';
import type { Result } from '../schema/index.ts';
import { failure } from '../schema/index.ts';
import type { BudgetCheckpoint } from './checkpoint.ts';

export interface Rule { name: string; cost: number; requests: number; windowMs: number }
export interface Caller { person: string; scope: 'person' | 'deployment' }
export interface Authority {
  whois(token: string): Promise<Result<Caller, 'auth'>>;
  report(token: string, callId: string, counters: Record<string, number>): Promise<Result<void, 'auth'>>;
}
export type Description = Result<DescribeResponse, Extract<ResponseEvent, { type: 'error' }>['code']>;
export interface Provider {
  describe(): Promise<Description>;
  run(request: AsyncIterable<RequestEvent>, token: string, signal: AbortSignal): AsyncIterable<ResponseEvent>;
}

export class Budgets {
  readonly #windows = new Map<string, { at: number; spent: number; reserved: number; requests: number }>();
  readonly rule: Rule;
  readonly now: () => number;
  readonly peopleLimit: number;
  readonly #checkpoint: BudgetCheckpoint | undefined;
  constructor(rule: Rule, now: () => number, peopleLimit = 4096, checkpoint?: BudgetCheckpoint) {
    if (!Number.isFinite(rule.cost) || rule.cost < 0 || !Number.isSafeInteger(rule.requests) || rule.requests < 1 || !Number.isSafeInteger(rule.windowMs) || rule.windowMs < 1 || !Number.isSafeInteger(peopleLimit) || peopleLimit < 1) throw new Error('The provider budget rule is invalid.');
    this.rule = Object.freeze({ ...rule }); this.now = now; this.peopleLimit = peopleLimit;
    this.#checkpoint = checkpoint;
    for (const window of checkpoint?.initial ?? []) {
      if (this.now() - window.at < rule.windowMs) this.#windows.set(window.person, { at: window.at, spent: window.spent + window.reserved, reserved: 0, requests: window.requests });
    }
  }

  reserve(person: string, maximumCost: number): Result<(actual: number) => void, 'budget'> {
    if (!Number.isFinite(maximumCost) || maximumCost < 0) return failure('budget', `${this.rule.name} has no bounded call estimate.`);
    for (const [id, window] of this.#windows) if (this.now() - window.at >= this.rule.windowMs && window.reserved === 0) this.#windows.delete(id);
    let window = this.#windows.get(person);
    if (!window || this.now() - window.at >= this.rule.windowMs) {
      if (!window && this.#windows.size >= this.peopleLimit) return failure('budget', `${this.rule.name} has reached its person limit.`);
      window = { at: this.now(), spent: 0, reserved: 0, requests: 0 };
      this.#windows.set(person, window);
    }
    if (window.spent + window.reserved + maximumCost > this.rule.cost || window.requests >= this.rule.requests) {
      return failure('budget', `${this.rule.name} would be exceeded.`);
    }
    window.reserved += maximumCost; window.requests += 1;
    let settled = false;
    const current = window;
    return { ok: true, value: actual => {
      if (settled) throw new Error('A provider reservation was settled twice.');
      if (!Number.isFinite(actual) || actual < 0) throw new Error('A provider reservation received invalid validated usage.');
      settled = true;
      current.reserved -= maximumCost;
      current.spent += actual;
    } };
  }

  checkpoint(): Promise<Result<void>> {
    return this.#checkpoint?.save([...this.#windows].map(([person, window]) => ({ person, ...window }))) ?? Promise.resolve({ ok: true, value: undefined });
  }
}

export function* events(items: readonly RequestEvent[]): Generator<RequestEvent> {
  for (const item of items) yield item;
}
