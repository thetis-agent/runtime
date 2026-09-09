/** Enforce call-time budgets before vendor access; PR-010, ADR 0020. */
import type { RequestEvent, ResponseEvent, ModelCap } from '../../contracts/provider/types.ts';
import type { Result } from '../schema/index.ts';
import { failure } from '../schema/index.ts';

export interface Rule { name: string; cost: number; requests: number; windowMs: number }
export interface Caller { person: string; scope: 'person' | 'deployment' }
export interface Authority {
  whois(token: string): Promise<Result<Caller, 'auth'>>;
  report(token: string, callId: string, counters: Record<string, number>): Promise<Result<void, 'auth'>>;
}
export interface Provider {
  describe(): Promise<{ models: ModelCap[] }>;
  run(request: AsyncIterable<RequestEvent>, token: string, signal: AbortSignal): AsyncIterable<ResponseEvent>;
}

export class Budgets {
  readonly #windows = new Map<string, { at: number; spent: number; reserved: number; requests: number }>();
  readonly rule: Rule;
  readonly now: () => number;
  readonly peopleLimit: number;
  constructor(rule: Rule, now: () => number, peopleLimit = 4096) {
    this.rule = rule; this.now = now; this.peopleLimit = peopleLimit;
  }

  reserve(person: string, maximumCost: number): Result<(actual: number) => void, 'budget'> {
    if (!Number.isFinite(maximumCost) || maximumCost < 0) return failure('budget', `${this.rule.name} has no bounded call estimate.`);
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
      settled = true;
      current.reserved -= maximumCost;
      current.spent += actual;
    } };
  }
}

export function* events(items: readonly RequestEvent[]): Generator<RequestEvent> {
  for (const item of items) yield item;
}
