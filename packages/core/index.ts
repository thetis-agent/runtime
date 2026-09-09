/** Keep the turn loop unprivileged and the stored head authoritative; ADR 0013, TE-001–011. */
import type { Provider } from '../../lib/provider/index.ts';
import type { Stage } from '../../lib/events/stages.ts';
import type { Clock } from '../../lib/events/index.ts';
import { failure } from '../../lib/schema/index.ts';
import type { Result, Schemas } from '../../lib/schema/index.ts';
import { SpillSink } from '../../lib/spill/index.ts';
import type { RequestEvent } from '../../contracts/provider/types.ts';
import type { Input, Envelope, Message, Prefix, ToolDef, Notice, End } from '../../contracts/turn-events/types.ts';
import { Dispatcher } from './dispatcher.ts';
import { compact } from './conversation.ts';
import type { Conversation } from './conversation.ts';
import { renderPrefix } from './prefix.ts';
import { modelExchange } from './model.ts';

export const stages = {};
export const defaults = { iterations: 8, window: 200000, reserve: 4096, historyMessages: 128, notices: 256, deadlineMs: 30000, resultBytes: 32768 };
export interface Options {
  conversation: string; model: string; provider: string; token: string; space: string;
  system: Message[]; roots: { path: string; mode: 'ro' | 'rw'; space: string }[];
  mode: { readOnly: boolean; deny: string[] }; refresh?: string[];
}
interface TurnState {
  seq: number; iteration: number; turn: number; reason: End['reason']; compactions: number;
  prefix: Prefix | undefined; history: Message[]; output: Message; usage: Record<string, number>;
}

export class Loop {
  readonly #dispatcher: Dispatcher;
  readonly #schemas: Schemas;
  readonly #provider: Provider;
  readonly #conversation: Conversation;
  readonly #notices: Notice[] = [];
  readonly #heads = new Map<string, RequestEvent[]>();
  #turn = 0;
  #active = false;
  constructor(handlers: readonly Stage[], schemas: Schemas, clock: Clock, provider: Provider, conversation: Conversation) {
    this.#dispatcher = new Dispatcher(handlers, schemas, clock); this.#schemas = schemas;
    this.#provider = provider; this.#conversation = conversation;
    this.#turn = conversation.project().history.filter(message => message.role === 'user').length;
  }

  notice(source: string, notice: Omit<Notice, 'source'>): Result<void, 'budget'> {
    if (this.#notices.length >= defaults.notices) return failure('budget', 'The notice queue is full.');
    const value = { ...notice, source };
    if (!this.#schemas.validator<Notice>('turn-events', 'notice')(value)) return failure('budget', 'The notice does not match its contract.');
    this.#notices.push(value); return { ok: true, value: undefined };
  }

  async turn(input: Input, options: Options, signal: AbortSignal): Promise<Result<Message, 'io' | 'budget' | 'provider'>> {
    if (this.#active) return failure('budget', 'The conversation already has an active turn.');
    this.#active = true;
    const view = this.#conversation.project();
    const state: TurnState = { ...view, seq: 0, iteration: 0, turn: ++this.#turn, reason: 'answer', compactions: 0, output: { role: 'assistant', content: [], source: 'core' }, usage: {} };
    try {
      const prepared = await this.#prepare(state, input, options);
      if (!prepared.ok) { state.reason = 'crash'; return prepared; }
      for (let iteration = 1; iteration <= defaults.iterations; iteration++) {
        state.iteration = iteration;
        if (signal.aborted) { state.reason = 'cancel'; break; }
        const result = await this.#iteration(state, options, signal);
        if (!result.ok) { state.reason = 'crash'; return result; }
        if (result.value) break;
        if (iteration === defaults.iterations) state.reason = 'limit';
      }
      const saved = await this.#conversation.append({ type: 'message', value: state.output });
      if (!saved.ok) return saved;
      this.#emit(state, options, 'output', { message: state.output, usage: state.usage });
      return { ok: true, value: state.output };
    } finally {
      const iterations = state.iteration; state.iteration = 0;
      this.#emit(state, options, 'end', { reason: state.reason, iterations, compactions: state.compactions });
      this.#active = false;
    }
  }

  async #prepare(state: TurnState, input: Input, options: Options): Promise<Result<void, 'io' | 'budget'>> {
    this.#emit(state, options, 'input', input);
    for (const notice of this.#notices.splice(0)) {
      const saved = await this.#conversation.append({ type: 'message', value: { role: 'tool', content: notice.content, source: notice.source } });
      if (!saved.ok) return saved;
    }
    if (options.refresh?.length) {
      const saved = await this.#conversation.append({ type: 'message', value: { role: 'system', content: [{ type: 'text', text: `The environment changed: ${options.refresh.join(', ')}.` }], source: 'core' } });
      if (!saved.ok) return saved; state.prefix = undefined;
    }
    const saved = await this.#conversation.append({ type: 'message', value: { role: 'user', content: [{ type: 'text', text: input.text }], source: 'core' } });
    if (!saved.ok) return saved;
    state.history = this.#conversation.project().history;
    return { ok: true, value: undefined };
  }

  async #iteration(state: TurnState, options: Options, signal: AbortSignal): Promise<Result<boolean, 'io' | 'budget' | 'provider'>> {
    const refreshed = !state.prefix;
    const retrieved = refreshed ? await this.#dispatcher.retrieve({ query: this.#latest(state), k: 4, budget: defaults.window - defaults.reserve, model: options.model }) : { entries: [], dropped: [] };
    if (refreshed) {
      const iteration = state.iteration; state.iteration = 0;
      this.#emit(state, options, 'retrieve', retrieved); state.iteration = iteration;
    }
    const history = compact(state.history, defaults.historyMessages);
    if (history.length < state.history.length) state.compactions++;
    const context = this.#dispatcher.context({ sections: { system: options.system, skills: [], harness: [], history }, budget: { window: defaults.window, reserve: defaults.reserve, used: 0 } });
    this.#emit(state, options, 'context', context);
    const offered = await this.#dispatcher.offer({ mode: options.mode });
    this.#emit(state, options, 'offer', { mode: options.mode, tools: offered });
    if (!state.prefix) {
      state.prefix = renderPrefix(options.system, retrieved.entries, offered);
      const saved = await this.#conversation.append({ type: 'prefix', value: state.prefix });
      if (!saved.ok) return saved;
    }
    const request = this.#request(state.prefix, [...context.sections.harness, ...context.sections.history], options);
    this.#emit(state, options, 'model.begin', { provider: options.provider, model: options.model, request });
    const model = await modelExchange(this.#provider, request, options.token, signal, event => {
      this.#emit(state, options, 'model.event', { event });
      if (event.type === 'delta.text') this.#emit(state, options, 'token', { text: event.text });
    });
    if (!model.ok) return model;
    state.usage = model.value.usage; state.output = { role: 'assistant', source: 'core', content: model.value.content };
    this.#emit(state, options, 'model.end', { stop: model.value.stop, usage: state.usage });
    if (model.value.stop === 'cancel') { state.reason = 'cancel'; return { ok: true, value: true }; }
    if (!model.value.calls.length) return { ok: true, value: true };
    for (const call of model.value.calls) {
      const result = await this.#call(state, options, call, offered);
      if (!result.ok || result.value) return result;
    }
    return { ok: true, value: false };
  }

  async #call(state: TurnState, options: Options, call: { id: string; name: string; args: string }, tools: ToolDef[]): Promise<Result<boolean, 'io' | 'budget'>> {
    let args: unknown;
    try { args = JSON.parse(call.args); } catch { args = undefined; }
    const sink = new SpillSink(options.space, call.id);
    const request = { id: call.id, name: call.name, args, mode: options.mode, roots: options.roots, deadlineMs: defaults.deadlineMs, budget: { resultBytes: defaults.resultBytes } };
    const answer = await this.#dispatcher.call(request, sink);
    for (const content of answer.content ?? []) if (content.type === 'text') {
      const written = await sink.write(Buffer.from(content.text));
      if (!written.ok) { await sink.abort(); return failure('io', written.error.message); }
    }
    const output = await sink.finish(); if (!output.ok) return output;
    if (output.value.spilled) answer.spilled = output.value.spilled;
    this.#emit(state, options, 'call', { request, answer });
    const text = answer.error?.message ?? (output.value.spilled ? `${output.value.spilled.head}\n${output.value.spilled.path}\n${output.value.spilled.tail}` : output.value.text);
    const message: Message = { role: 'tool', source: 'core', toolCallId: call.id, content: [{ type: 'text', text }] };
    const saved = await this.#conversation.append({ type: 'message', value: message });
    if (!saved.ok) return saved; state.history.push(message);
    return { ok: true, value: answer.endsTurn === true || tools.find(tool => tool.name === call.name)?.endsTurn === true };
  }

  #request(prefix: Prefix, history: Message[], options: Options): RequestEvent[] {
    let frames = this.#heads.get(prefix.bytes);
    if (!frames) {
      const head: unknown = JSON.parse(prefix.bytes);
      const validate = this.#schemas.validator<RequestEvent>('provider', 'requestEvent');
      if (!Array.isArray(head) || !head.every((frame: unknown): frame is RequestEvent => validate(frame))) throw new Error('The stored prefix is invalid.');
      frames = head;
      if (this.#heads.size >= 32) this.#heads.clear();
      this.#heads.set(prefix.bytes, frames);
    }
    return [ { type: 'begin', id: `${options.conversation}-${String(this.#turn)}`, model: options.model, cache: { prefixThrough: frames.filter(frame => frame.type === 'message').length - 1 } }, ...frames,
      ...history.map(message => ({ type: 'message', role: message.role, content: message.content, ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }) } satisfies RequestEvent)), { type: 'end' } ];
  }

  #latest(state: TurnState): string { return state.history.at(-1)?.content.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? ''; }
  #emit(state: TurnState, options: Options, type: Envelope['type'], payload: Envelope['payload']): void {
    this.#dispatcher.observe({ type, payload, conversation: options.conversation, turn: state.turn, iteration: state.iteration, seq: state.seq++ });
  }
}
