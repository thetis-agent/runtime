/** Keep vendor requests outside the kernel and behind caller reservations; ADR 0019–0020, PR-001–012. */
import type { RequestEvent, ResponseEvent, ModelCap } from '../../contracts/provider/types.ts';
import type { Authority, Budgets, Description } from '../../lib/provider/index.ts';
import { ProviderEngine } from '../../lib/provider/engine.ts';
import type { Vendor } from '../../lib/provider/engine.ts';
import type { Clock } from '../../lib/events/index.ts';
import type { Schemas } from '../../lib/schema/index.ts';
import { vendorRequest } from './request.ts';
import { sse } from './sse.ts';
import { chunk, error } from './wire.ts';
import { ResponseState } from './response.ts';

export const stages = {};
export const settings = { deadlineMs: 120000, eventBytes: 1024 * 1024, models: 256, cacheMarkers: 4 };
export interface Configuration { endpoint: string; key: string; models: readonly ModelCap[]; deadlineMs?: number; eventBytes?: number; cacheMarkers?: number }
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

class CompatibleVendor implements Vendor {
  readonly #config: Configuration;
  readonly #schemas: Schemas;
  readonly #clock: Clock;
  readonly #fetch: Fetcher;
  constructor(config: Configuration, schemas: Schemas, clock: Clock, fetcher: Fetcher) {
    const endpoint = new URL(config.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('The provider endpoint must be an HTTPS URL without credentials or query parameters.');
    if (config.models.length > settings.models || config.models.some(model => model.images)) throw new Error('The provider model declarations exceed supported capabilities.');
    this.#config = structuredClone(config); this.#schemas = schemas; this.#clock = clock; this.#fetch = fetcher;
  }

  describe(): Promise<Description> { return Promise.resolve({ ok: true, value: { models: structuredClone([...this.#config.models]) } }); }

  estimate(request: readonly RequestEvent[]): number {
    const begin = request[0]; const model = begin?.type === 'begin' ? this.#config.models.find(model => model.id === begin.model) : undefined;
    const price = model?.price;
    if (!model || price?.in === undefined || price.out === undefined) return Infinity;
    if (Object.values(price).some(value => typeof value === 'number' && (!Number.isFinite(value) || value < 0))) return Infinity;
    if (model.cache === 'explicit' && (price.cachedRead === undefined || price.cachedWrite === undefined)) return Infinity;
    return (model.contextWindow * Math.max(price.in, price.cachedWrite ?? price.in, price.cachedRead ?? price.in) + model.maxOutput * price.out) / 1000000;
  }

  async *exchange(request: readonly RequestEvent[], signal: AbortSignal): AsyncGenerator<ResponseEvent> {
    const begin = request[0]; if (begin?.type !== 'begin') throw new Error('The normalized request lost begin.');
    const model = this.#config.models.find(model => model.id === begin.model);
    if (!model) { yield { type: 'error', code: 'provider', message: 'The requested model is not registered.' }; return; }
    const body = vendorRequest(request, model, this.#config.cacheMarkers ?? settings.cacheMarkers);
    if (!body.ok) { yield { type: 'error', ...body.error }; return; }
    if (new URL(this.#config.endpoint).hostname === 'openrouter.ai') body.value['provider'] = { max_price: { prompt: model.price?.in, completion: model.price?.out, request: 0 } };
    const controller = new AbortController(); const timer = new AbortController();
    const cancel = (): void => { controller.abort(); }; signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
    const expired = (): boolean => controller.signal.aborted && !signal.aborted;
    const deadline = this.#clock.wait(this.#config.deadlineMs ?? settings.deadlineMs, timer.signal).then(() => { if (!timer.signal.aborted) controller.abort(); });
    try {
      const response = await this.#fetch(this.#config.endpoint, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${this.#config.key}`, 'content-type': 'application/json' }, body: JSON.stringify(body.value), signal: controller.signal });
      if (!response.ok) { await response.body?.cancel(); yield error(response.status); return; }
      if (!response.body) { yield { type: 'error', code: 'provider', message: 'The vendor returned no response stream.' }; return; }
      yield { type: 'start', id: begin.id, model: model.id };
      for await (const event of this.#stream(response.body, model)) {
        if (expired()) { yield { type: 'error', code: 'deadline', message: 'The vendor request exceeded its deadline.' }; return; }
        if (signal.aborted) { yield { type: 'stop', reason: 'cancel' }; return; }
        yield event;
      }
    } catch {
      yield signal.aborted ? { type: 'stop', reason: 'cancel' } : { type: 'error', code: expired() ? 'deadline' : 'provider', message: expired() ? 'The vendor request exceeded its deadline.' : 'The vendor request failed.' };
    } finally { timer.abort(); controller.abort(); signal.removeEventListener('abort', cancel); await deadline; }
  }

  async *#stream(body: ReadableStream<Uint8Array>, model: ModelCap): AsyncGenerator<ResponseEvent> {
    const state = new ResponseState(model);
    for await (const item of sse(body, this.#config.eventBytes ?? settings.eventBytes)) {
      if (!item.ok) { yield { type: 'error', ...item.error }; return; }
      if (item.value === '[DONE]') { yield state.done(); return; }
      const decoded = chunk(item.value, this.#schemas); if (!decoded.ok) { yield { type: 'error', ...decoded.error }; return; }
      const mapped = state.consume(decoded.value); if (!mapped.ok) { yield { type: 'error', ...mapped.error }; return; }
      for (const event of mapped.value) { yield event; if (event.type === 'error') return; }
    }
    yield { type: 'error', code: 'provider', message: 'The vendor stream ended without its terminal marker.' };
  }
}

export function create(config: Configuration, schemas: Schemas, clock: Clock, authority: Authority, budgets: Budgets, fetcher: Fetcher = fetch): ProviderEngine {
  return new ProviderEngine(new CompatibleVendor(config, schemas, clock, fetcher), authority, budgets);
}
