/** Keep authentication, reservations and final usage on every provider path; PR-003–012. */
import { reserve } from './reservation.ts';
import type { RequestEvent, ResponseEvent } from '@/contracts/provider/types.ts';
import type { Authority, Provider, Budgets, Description } from './index.ts';
import type { Result } from '@/lib/schema/index.ts';
import { failure } from '@/lib/schema/index.ts';

export type Counters = Extract<ResponseEvent, { type: 'usage' }>['counters'];
export type Begin = Extract<RequestEvent, { type: 'begin' }>;
export interface Vendor {
  describe(): Promise<Description>;
  estimate(request: readonly RequestEvent[]): number;
  exchange(request: readonly RequestEvent[], signal: AbortSignal): AsyncIterable<ResponseEvent>;
}
export const defaults = { requestBytes: 4 * 1024 * 1024, requestFrames: 8192, responseEvents: 65536 };

async function collect(source: AsyncIterable<RequestEvent>, limits: typeof defaults): Promise<Result<RequestEvent[], 'provider' | 'context'>> {
  const result: RequestEvent[] = [];
  let bytes = 0;
  for await (const frame of source) {
    bytes += Buffer.byteLength(JSON.stringify(frame));
    if (bytes > limits.requestBytes || result.length >= limits.requestFrames) return failure('context', 'The request exceeds the provider buffer limit.');
    if (result.length === 0 ? frame.type !== 'begin' : frame.type === 'begin') return failure('provider', 'The request must have exactly one initial begin.');
    result.push(frame);
    if (frame.type === 'end') return { ok: true, value: result };
    if (frame.type === 'cancel') return failure('provider', 'Cancellation belongs to the provider control channel.');
  }
  return failure('provider', 'The request ended without end.');
}

export class ProviderEngine implements Provider {
  readonly #vendor: Vendor;
  readonly #authority: Authority;
  readonly #budgets: Budgets;
  readonly #limits: typeof defaults;
  readonly #scope: 'person' | 'deployment';
  #fault: Result<void> | undefined;
  constructor(vendor: Vendor, authority: Authority, budgets: Budgets, scope: 'person' | 'deployment' = 'deployment', limits = defaults) {
    this.#vendor = vendor; this.#authority = authority; this.#budgets = budgets;
    this.#scope = scope; this.#limits = limits;
  }
  describe(): Promise<Description> {
    return this.#fault && !this.#fault.ok ? Promise.resolve(failure('budget', 'The provider cannot persist its budget or attribution; new calls are refused.')) : this.#vendor.describe();
  }

  async *run(request: AsyncIterable<RequestEvent>, token: string, signal: AbortSignal): AsyncGenerator<ResponseEvent> {
    if (this.#fault && !this.#fault.ok) { yield { type: 'error', code: 'budget', message: 'The provider cannot persist its budget or attribution; new calls are refused.' }; return; }
    const caller = await this.#authority.whois(token);
    if (!caller.ok) { yield { type: 'error', ...caller.error }; return; }
    const collected = await collect(request, this.#limits);
    if (signal.aborted) { yield { type: 'usage', counters: { cost: 0 } }; yield { type: 'stop', reason: 'cancel' }; return; }
    if (!collected.ok) { yield { type: 'error', ...collected.error }; return; }
    const begin = collected.value[0];
    if (begin?.type !== 'begin') throw new Error('The validated provider request lost its begin.');
    const estimate = this.#vendor.estimate(collected.value);
    const reservation = this.#scope === 'deployment' || caller.value.cost !== undefined ? reserve(this.#budgets, caller.value, token, estimate, this.#scope) : undefined;
    if (reservation && !reservation.ok) { yield { type: 'error', ...reservation.error }; return; }
    if (reservation?.ok) {
      const persisted = await this.#budgets.checkpoint();
      if (!persisted.ok) { this.#fault = persisted; reservation.value(0); yield { type: 'error', code: 'budget', message: 'The provider cannot persist its reservation; the vendor was not called.' }; return; }
    }
    const state = { counters: { cost: estimate } satisfies Counters, measured: false, reported: false };
    let terminal: ResponseEvent | undefined;
    try {
      for await (const event of this.#exchange(collected.value, begin, token, signal, state)) {
        // Socket clients close on stop/error; their next call must see durable accounting.
        if (event.type === 'stop' || event.type === 'error') { terminal = event; break; }
        yield event;
      }
    }
    finally {
      if (!state.reported) { const report = await this.#authority.report(token, begin.id, state.counters); if (!report.ok) this.#fault = report; }
      if (reservation?.ok) { reservation.value(state.counters.cost); const saved = await this.#budgets.checkpoint(); if (!saved.ok) this.#fault = saved; }
    }
    if (terminal) yield terminal;
  }

  async *#exchange(request: RequestEvent[], begin: Begin, token: string, signal: AbortSignal, state: { counters: Counters; measured: boolean; reported: boolean }): AsyncGenerator<ResponseEvent> {
    let count = 0;
    let reason: 'end' | 'tool_calls' | 'length' | 'cancel' = 'end';
    for await (const event of this.#vendor.exchange(request, signal)) {
      if (signal.aborted) { reason = 'cancel'; break; }
      if (++count > this.#limits.responseEvents) { yield { type: 'error', code: 'context', message: 'The provider response exceeds its event limit.' }; return; }
      if (event.type === 'usage') { state.counters = event.counters; state.measured = true; continue; }
      if (event.type === 'stop') { reason = event.reason; break; }
      yield event;
      if (event.type === 'error') return;
    }
    if (signal.aborted) reason = 'cancel';
    if (!state.measured && reason !== 'cancel') {
      yield { type: 'error', code: 'provider', message: 'The provider ended without usage.' }; return;
    }
    yield { type: 'usage', counters: state.counters };
    state.reported = true;
    const report = await this.#authority.report(token, begin.id, state.counters);
    if (!report.ok) { this.#fault = report; yield { type: 'error', ...report.error }; return; }
    yield { type: 'stop', reason };
  }
}
