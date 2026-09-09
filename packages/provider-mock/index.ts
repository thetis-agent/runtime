/** Script the complete provider wire without a model or a key; PR-014. */
import { createHash } from 'node:crypto';
import type { RequestEvent, ResponseEvent, ModelCap } from '../../contracts/provider/types.ts';
import type { Authority, Provider } from '../../lib/provider/index.ts';
import type { Budgets } from '../../lib/provider/index.ts';

export const stages = {};
export const settings = { requestBytes: 4 * 1024 * 1024, cacheEntries: 256, scriptEvents: 4096, maximumCost: 0.01 };
export const model: ModelCap = {
  id: 'scripted', contextWindow: 200000, maxOutput: 4096, tools: true,
  images: true, seed: true, reasoning: true, cache: 'explicit'
};
type Script = readonly ResponseEvent[];
type Begin = Extract<RequestEvent, { type: 'begin' }>;
type Counters = Extract<ResponseEvent, { type: 'usage' }>['counters'];

export class MockProvider implements Provider {
  readonly #cache = new Map<string, number>();
  readonly #scripts: readonly Script[];
  readonly #authority: Authority;
  readonly #budgets: Budgets;
  #calls = 0;
  readonly capturedPrefixes: string[] = [];

  constructor(scripts: readonly Script[], authority: Authority, budgets: Budgets) {
    if (scripts.length > settings.scriptEvents || scripts.some(script => script.length > settings.scriptEvents)) throw new Error('Mock scripts exceed their event limit.');
    this.#scripts = scripts; this.#authority = authority; this.#budgets = budgets;
  }

  describe(): Promise<{ models: ModelCap[] }> { return Promise.resolve({ models: [structuredClone(model)] }); }

  async *run(request: AsyncIterable<RequestEvent>, token: string, signal: AbortSignal): AsyncGenerator<ResponseEvent> {
    const caller = await this.#authority.whois(token);
    if (!caller.ok) { yield { type: 'error', ...caller.error }; return; }
    const reservation = this.#budgets.reserve(caller.value.person, settings.maximumCost);
    if (!reservation.ok) { yield { type: 'error', ...reservation.error }; return; }
    let charged = settings.maximumCost;
    try {
      const frames: RequestEvent[] = [];
      let bytes = 0;
      for await (const frame of request) {
        bytes += Buffer.byteLength(JSON.stringify(frame));
        if (bytes > settings.requestBytes) { yield { type: 'error', code: 'context', message: 'The request exceeds the provider buffer limit.' }; return; }
        frames.push(frame);
      }
      const begin = frames[0];
      if (begin?.type !== 'begin' || frames.at(-1)?.type !== 'end') {
        yield { type: 'error', code: 'provider', message: 'The request must start with begin and finish with end.' }; return;
      }
      const counters = this.#usage(begin, frames);
      charged = counters.cost;
      yield* this.#response(begin, token, counters, signal);
    } finally { reservation.value(charged); }
  }

  #usage(begin: Begin, frames: readonly RequestEvent[]): Counters {
    const messages = frames.filter(frame => frame.type === 'message');
    const prefix = JSON.stringify([
      ...messages.slice(0, (begin.cache?.prefixThrough ?? -1) + 1),
      ...frames.filter(frame => frame.type === 'tool')
    ]);
    const key = createHash('sha256').update(begin.model).update(prefix).digest('hex');
    const prefixTokens = Math.ceil(Buffer.byteLength(prefix) / 4);
    const cached = this.#cache.get(key) ?? 0;
    if (this.#cache.size >= settings.cacheEntries) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    this.#cache.set(key, prefixTokens);
    if (this.capturedPrefixes.length >= settings.cacheEntries) this.capturedPrefixes.shift();
    this.capturedPrefixes.push(prefix);
    const input = Math.max(prefixTokens, Math.ceil(Buffer.byteLength(JSON.stringify(frames)) / 4));
    return { cost: 0.001, in: input, out: 1, cached, cached_write: cached ? 0 : prefixTokens };
  }

  async *#response(begin: Begin, token: string, counters: Counters, signal: AbortSignal): AsyncGenerator<ResponseEvent> {
    const script = this.#scripts[this.#calls++] ?? [{ type: 'delta.text', text: 'Hello.' }];
    yield { type: 'start', id: begin.id, model: begin.model };
    let reason: 'end' | 'tool_calls' | 'length' | 'cancel' = 'end';
    let usage = counters;
    for (const event of script) {
      if (signal.aborted) { reason = 'cancel'; break; }
      if (event.type === 'stop') { reason = event.reason; break; }
      if (event.type === 'usage') { usage = event.counters; continue; }
      yield structuredClone(event);
      if (event.type === 'error') return;
    }
    if (signal.aborted) reason = 'cancel';
    yield { type: 'usage', counters: usage };
    yield { type: 'stop', reason };
    const reported = await this.#authority.report(token, begin.id, usage);
    if (!reported.ok) throw new Error('The mock authority refused completed usage attribution.');
  }
}
