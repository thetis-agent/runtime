/** Enforce hook ownership, frozen observers and isolated appends; TE-002–003, TE-025–026. */
import type { Envelope, Context, ToolDef, OfferRequest, CallRequest, CallAnswer } from '../../contracts/turn-events/types.ts';
import type { RetrieveRequest, RetrieveAnswer } from '../../contracts/skills/types.ts';
import type { Stage, StageRow } from '../../lib/events/stages.ts';
import { frozen } from '../../lib/events/stages.ts';
import type { Clock } from '../../lib/events/index.ts';
import type { Schemas } from '../../lib/schema/index.ts';
import type { SpillSink } from '../../lib/spill/index.ts';

export const defaults = { observerMs: 5, stages: 256, rows: 512, tools: 1024, appendMessages: 256 };
interface Owner { stage: Stage; tool: ToolDef }

export class Dispatcher {
  readonly #stages: readonly Stage[];
  readonly #schemas: Schemas;
  readonly #clock: Clock;
  readonly #trusted: ReadonlySet<string>;
  readonly #owners = new Map<string, Owner>();
  readonly rows: StageRow[] = [];
  #sink: ((row: StageRow) => void) | undefined;
  #epoch = 0;
  report(sink: (row: StageRow) => void): void { this.#sink = sink; this.#epoch++; }

  constructor(stages: readonly Stage[], schemas: Schemas, clock: Clock, trusted: ReadonlySet<string> = new Set()) {
    if (stages.length > defaults.stages) throw new Error('The stage pool is full.');
    if (stages.filter(stage => stage.retrieve).length > 1) throw new Error('Two stages provide stage/retrieve.');
    if (stages.some(stage => stage.gateway && stage.call)) throw new Error('A gateway cannot declare the own hook call.');
    if (stages.some(stage => stage.section !== undefined && !['harness', 'history'].includes(stage.section))) throw new Error('Iteration appenders cannot write immutable prefix sections.');
    this.#stages = stages.map(stage => Object.freeze({ ...stage })); this.#schemas = schemas; this.#clock = clock; this.#trusted = trusted;
  }

  observe(event: Envelope): void {
    for (const stage of this.#stages) {
      if (!stage.observe) continue;
      const start = this.#clock.now(); const epoch = this.#epoch;
      try {
        const value = stage.observe(frozen(event));
        if (value instanceof Promise) void value.catch(() => { this.#row(stage, event.type, 'observer-throw', start, epoch); });
        this.#row(stage, event.type, value !== undefined ? 'contract-violation' : this.#clock.now() - start > defaults.observerMs ? 'observer-budget' : 'ok', start);
      } catch { this.#row(stage, event.type, 'observer-throw', start); }
    }
  }

  context(context: Context): Context {
    const result = structuredClone(context);
    for (const stage of this.#stages) {
      if (!stage.context) continue;
      const start = this.#clock.now(); const epoch = this.#epoch;
      const additions: Context['sections']['harness'] = [];
      try {
        const value = stage.context(message => {
          if (additions.length >= defaults.appendMessages) throw new Error('The context append limit was exceeded.');
          if (!this.#schemas.validator('turn-events', 'message')(message)) throw new Error('The context append violates the message contract.');
          additions.push({ ...structuredClone(message), source: stage.source });
        }, frozen(result));
        if (value instanceof Promise) void value.catch(() => { this.#row(stage, 'context', 'contract-violation', start, epoch); });
        if (value !== undefined) { this.#row(stage, 'context', 'contract-violation', start); continue; }
        result.sections[stage.section ?? 'harness'].push(...additions);
        this.#row(stage, 'context', 'ok', start);
      } catch { this.#row(stage, 'context', 'contract-violation', start); }
    }
    return result;
  }

  async retrieve(request: RetrieveRequest): Promise<RetrieveAnswer> {
    const stage = this.#stages.find(item => item.retrieve);
    if (!stage?.retrieve) return { entries: [], dropped: [] };
    const start = this.#clock.now();
    try {
      const answer = await stage.retrieve(frozen(request));
      if (this.#schemas.validator<RetrieveAnswer>('skills', 'retrieveAnswer')(answer)) { this.#row(stage, 'retrieve', 'ok', start); return answer; }
      this.#row(stage, 'retrieve', 'contract-violation', start);
    } catch { this.#row(stage, 'retrieve', 'handler-error', start); }
    return { entries: [], dropped: [] };
  }

  async offer(request: OfferRequest): Promise<ToolDef[]> {
    this.#owners.clear();
    const validate = this.#schemas.validator<ToolDef>('turn-events', 'toolDef');
    for (const stage of this.#stages) {
      if (!stage.offer) continue;
      const start = this.#clock.now();
      try {
        const tools = await stage.offer(frozen(request));
        if (!Array.isArray(tools)) { this.#row(stage, 'offer', 'contract-violation', start); continue; }
        for (const item of tools) {
          if (!validate(item)) { this.#row(stage, 'offer', 'contract-violation', start); continue; }
          const tool = { ...structuredClone(item), source: stage.source };
          if (tool.derived && !this.#trusted.has(stage.source)) { tool.readOnly = false; this.#row(stage, 'offer', 'derived-untrusted', start); }
          if (request.mode.readOnly && !tool.readOnly || request.mode.deny.includes(tool.name) || request.mode.deny.includes(`${stage.source.split('@')[0] ?? stage.source}/${tool.name}`)) continue;
          if (this.#owners.has(tool.name) || this.#owners.size >= defaults.tools) throw new Error('The offered set has a collision or exceeds its limit.');
          this.#owners.set(tool.name, { stage, tool });
        }
        this.#row(stage, 'offer', 'ok', start);
      } catch { this.#row(stage, 'offer', 'handler-error', start); }
    }
    return [...this.#owners.values()].map(owner => structuredClone(owner.tool));
  }

  async call(request: CallRequest, sink: SpillSink): Promise<CallAnswer> {
    const owner = this.#owners.get(request.name);
    if (!owner) return this.#error(request.id, 'not-offered', `${request.name} was not offered.`);
    if (request.mode['readOnly'] === true && !owner.tool.readOnly) return this.#error(request.id, 'read-only-mode', `${request.name} is not available in read-only mode.`);
    const deny = request.mode['deny'];
    if (Array.isArray(deny) && (deny.includes(request.name) || deny.includes(`${owner.stage.source.split('@')[0] ?? owner.stage.source}/${request.name}`))) return this.#error(request.id, 'read-only-mode', `${request.name} is not available in this mode.`);
    if (!this.#schemas.arguments(owner.tool.schema, request.args)) return this.#error(request.id, 'invalid-args', `${request.name} arguments do not match the offered schema.`);
    if (!owner.stage.call) return this.#error(request.id, 'gone', `${request.name} no longer has a handler.`);
    const controller = new AbortController();
    try {
      const answer: unknown = await Promise.race([
        owner.stage.call(frozen(request), sink),
        this.#clock.wait(request.deadlineMs, controller.signal).then(() => this.#error(request.id, 'deadline', `${request.name} exceeded its deadline.`))
      ]);
      if (this.#schemas.validator<CallAnswer>('turn-events', 'callAnswer')(answer) && answer.id === request.id) return answer;
      return this.#error(request.id, 'tool', `${request.name} returned an invalid answer.`);
    } catch { return this.#error(request.id, 'tool', `${request.name} failed.`); }
    finally { controller.abort(); }
  }

  #error(id: string, code: NonNullable<CallAnswer['error']>['code'], message: string): CallAnswer {
    return { id, ok: false, error: { code, message } };
  }
  #row(stage: Stage, event: string, outcome: string, start: number, epoch = this.#epoch): void {
    if (this.rows.length >= defaults.rows) this.rows.shift();
    const row = { source: stage.source, event, outcome, elapsed: this.#clock.now() - start };
    this.rows.push(row); if (epoch === this.#epoch) this.#sink?.(row);
  }
}
