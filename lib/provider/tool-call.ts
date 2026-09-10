/** Reuse durable cost admission for paid tools without model-stream messages; ADR 0020, TS-005–007. */
import { randomUUID } from 'node:crypto';
import type { CallRequest, CallAnswer, ToolDef } from '@/contracts/turn-events/types.ts';
import type { Authority, Budgets, Caller } from './index.ts';
import type { Schemas } from '@/lib/schema/index.ts';
import { reserve } from './reservation.ts';
import { toolError } from '@/lib/service/tool-client.ts';

export interface PaidTool {
  definitions: readonly ToolDef[];
  check?(request: CallRequest, caller: Caller): CallAnswer | undefined;
  estimate(request: CallRequest): number;
  execute(request: CallRequest, caller: Caller, signal: AbortSignal): Promise<CallAnswer>;
}

export class PaidTools {
  readonly #tools: PaidTool;
  readonly #authority: Authority;
  readonly #budgets: Budgets;
  readonly #schemas: Schemas;
  #failed = false;
  constructor(tools: PaidTool, authority: Authority, budgets: Budgets, schemas: Schemas) {
    this.#tools = tools; this.#authority = authority; this.#budgets = budgets; this.#schemas = schemas;
  }

  async call(request: CallRequest, token: string, signal: AbortSignal): Promise<CallAnswer> {
    if (this.#failed) return toolError(request.id, 'budget', 'Tool accounting failed; further calls are refused.');
    const caller = await this.#authority.whois(token);
    if (!caller.ok) return toolError(request.id, 'tool', 'The tool service could not authenticate the caller.');
    const definition = this.#tools.definitions.find(tool => tool.name === request.name);
    if (!definition) return toolError(request.id, 'not-offered', 'The tool service does not offer this operation.');
    if (!this.#schemas.arguments(definition.schema, request.args)) return toolError(request.id, 'invalid-args', 'The tool arguments do not match their schema.');
    const deny = request.mode['deny'];
    if (request.mode['readOnly'] === true && !definition.readOnly || Array.isArray(deny) && (deny.includes(request.name) || deny.includes(`${definition.source.split('@')[0] ?? ''}/${request.name}`))) return toolError(request.id, 'read-only-mode', 'This operation is not available in this mode.');
    const checked = this.#tools.check?.(request, caller.value); if (checked) return checked;
    if (aborted(signal)) return toolError(request.id, 'deadline', 'The tool request was cancelled before admission.');
    const maximum = this.#tools.estimate(request);
    const reserved = reserve(this.#budgets, caller.value, token, maximum, 'deployment');
    if (!reserved.ok) return toolError(request.id, 'budget', reserved.error.message);
    if (!(await this.#budgets.checkpoint()).ok) { reserved.value(0); this.#failed = true; return toolError(request.id, 'budget', 'The tool cost reservation could not be stored.'); }
    let answer: CallAnswer;
    let invoked = false;
    try {
      if (aborted(signal)) answer = toolError(request.id, 'deadline', 'The tool request was cancelled before execution.');
      else { invoked = true; answer = await this.#tools.execute(request, caller.value, signal); }
    } catch { answer = toolError(request.id, 'tool', 'The tool operation failed.'); }
    // The reviewed maximum remains charged when external work may continue after a disconnect.
    const cost = invoked ? maximum : 0;
    const reported = await this.#authority.report(token, randomUUID(), { cost, requests: invoked ? 1 : 0 });
    reserved.value(cost); const saved = await this.#budgets.checkpoint();
    if (!reported.ok || !saved.ok) { this.#failed = true; return toolError(request.id, 'budget', 'The tool cost could not be recorded.'); }
    return { ...answer, data: { ...answer.data, reservedCost: cost } };
  }
}

function aborted(signal: AbortSignal): boolean { return signal.aborted; }
