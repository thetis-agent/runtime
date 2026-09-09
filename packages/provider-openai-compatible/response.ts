/** Preserve fragmented calls and delay termination until accounting is received; PR-003, PR-006–007. */
import type { ResponseEvent, ModelCap } from '../../contracts/provider/types.ts';
import type { Result } from '../../lib/schema/index.ts';
import { failure, isObject } from '../../lib/schema/index.ts';
import { error, usage } from './wire.ts';

export class ResponseState {
  readonly #calls = new Map<number, { id: string; name: string }>();
  readonly #model: ModelCap;
  #finish: 'end' | 'tool_calls' | 'length' | undefined;
  #usage = false;
  constructor(model: ModelCap) { this.#model = model; }

  consume(frame: Record<string, unknown>): Result<ResponseEvent[], 'provider'> {
    if (isObject(frame['error'])) {
      const code = frame['error']['code']; return { ok: true, value: [error(typeof code === 'number' ? code : 502)] };
    }
    const result: ResponseEvent[] = [];
    const choices: unknown[] = Array.isArray(frame['choices']) ? frame['choices'] : [];
    for (const choice of choices) if (isObject(choice)) {
      const delta = choice['delta'];
      if (isObject(delta)) { const mapped = this.#delta(delta); if (!mapped.ok) return mapped; result.push(...mapped.value); }
      const reason = choice['finish_reason'];
      if (typeof reason === 'string') {
        if (!['stop', 'tool_calls', 'length'].includes(reason)) return failure('provider', 'The vendor returned an unsupported finish reason.');
        this.#finish = reason === 'tool_calls' ? 'tool_calls' : reason === 'length' ? 'length' : 'end';
      }
    }
    if (isObject(frame['usage'])) { const accounting = usage(frame['usage'], this.#model); if (!accounting.ok) return accounting; this.#usage = true; result.push(accounting.value); }
    return { ok: true, value: result };
  }

  #delta(delta: Record<string, unknown>): Result<ResponseEvent[], 'provider'> {
    const events: ResponseEvent[] = [];
    const reasoning = delta['reasoning'] ?? delta['reasoning_content']; const details = delta['reasoning_details'];
    if (typeof reasoning === 'string' && reasoning || Array.isArray(details) && details.length) events.push({ type: 'delta.reasoning', ...(typeof reasoning === 'string' ? { text: reasoning } : {}), ...(Array.isArray(details) ? { opaque: { reasoning_details: details } } : {}) });
    const content = delta['content']; if (typeof content === 'string' && content) events.push({ type: 'delta.text', text: content });
    const calls: unknown[] = Array.isArray(delta['tool_calls']) ? delta['tool_calls'] : [];
    for (const value of calls) if (isObject(value)) { const call = this.#call(value); if (!call.ok) return call; events.push(call.value); }
    if (this.#finish && events.length) return failure('provider', 'The vendor sent content after its finish marker.');
    return { ok: true, value: events };
  }

  #call(value: Record<string, unknown>): Result<ResponseEvent, 'provider'> {
    const index = value['index']; const fn = value['function'];
    if (typeof index !== 'number') throw new Error('A validated tool fragment lost its index.');
    const previous = this.#calls.get(index); const id = typeof value['id'] === 'string' ? value['id'] : previous?.id;
    const name = isObject(fn) && typeof fn['name'] === 'string' ? fn['name'] : previous?.name;
    if (!id || !name || previous && (previous.id !== id || previous.name !== name)) return failure('provider', 'The vendor tool fragment has no stable call identity.');
    this.#calls.set(index, { id, name });
    return { ok: true, value: { type: 'delta.tool_call', callId: id, ...(previous ? {} : { name }), args: isObject(fn) && typeof fn['arguments'] === 'string' ? fn['arguments'] : '' } };
  }

  done(): ResponseEvent {
    return this.#finish && this.#usage ? { type: 'stop', reason: this.#finish } : { type: 'error', code: 'provider', message: 'The vendor ended without a finish marker and final usage.' };
  }
}
