import { StepResultSchema, TurnEventSchema } from "../../contracts/schemas/pipeline.js";
import { parseSchema } from "../../lib/validation.js";
import { contentText, normalizeMessage, textContent } from "../../lib/content.js";
import type { Fences, Message, SessionRecord, StepContext, StepRef, TurnEvent, TurnOptions, Userspace } from "../../contracts/index.js";
import { CodedError, errorMessage } from "../../lib/error.js";
import { newId, now } from "../../lib/ids.js";
import type { Journal } from "../../lib/journal.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { KernelConfig } from "../config.js";
import type { PackageManager } from "../packages/manager.js";
import type { Settings } from "../settings.js";
import type { Enumerator } from "./enumerator.js";

export type Emit = (event: TurnEvent) => void;

export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CodedError("turn cancelled", "cancelled");
}

/**
 * Runs one turn: enumerate, dispatch each step into the fence, apply mutations, persist. Every step is a
 * package's, run in the caller's fence; the kernel never makes a model call, so what a step streams through
 * `ctx.emit` is relayed as it is, and `usage` and the first `error` are the only events the kernel reads.
 */
export class PipelineRunner {
  constructor(
    private readonly config: KernelConfig,
    private readonly settings: Settings,
    private readonly enumerator: Enumerator,
    private readonly packages: PackageManager,
    private readonly fences: Fences,
    private readonly store: SessionStore,
    private readonly journal: Journal,
  ) {}

  /**
   * An aborted `signal` ends the turn with an `error` event of code `cancelled`; whatever was applied before is
   * still saved. A step that was running when the signal fired returns its partial result rather than throwing,
   * so the check after the loop is what turns a cancel during the last step into that one event.
   */
  async runTurn(us: Userspace, session: SessionRecord, input: Message[], emitOut: Emit, signal?: AbortSignal, opts: TurnOptions = {}): Promise<SessionRecord> {
    const turn = { id: newId("t"), input };
    const started = Date.now();
    // What the steps reported this turn, summed; it is package-reported, so it is journaled under that name.
    const reported: Record<string, number> = {};
    let failure: { message: string; code?: string } | undefined;
    // What the running step has streamed as whole messages: each assistant message, and each tool result
    // as the tool message it becomes. A step that dies -- the fence with it -- returns nothing, and these
    // are then all there is of what the turn said and did.
    const streamed: Message[] = [];
    const emit: Emit = (event) => {
      if (event.type === "usage") for (const [k, v] of Object.entries(event.usage)) reported[k] = (reported[k] ?? 0) + v;
      if (event.type === "error" && !failure) failure = { message: event.message, code: event.code };
      if (event.type === "message") streamed.push(normalizeMessage(event.message));
      if (event.type === "tool.result") streamed.push({ role: "tool", content: event.content ?? textContent(String(event.result ?? "")), toolCallId: event.id, name: event.name });
      emitOut(event.type === "message" ? { ...event, message: normalizeMessage(event.message) } : event);
    };
    const info = { id: session.id, user: session.user, parent: session.parent };
    const packages = this.packages.installed(us);
    const ctx: StepContext = {
      session: info,
      turn,
      conversation: [...session.conversation, ...input],
      call: { model: opts.model || this.config.model, messages: [], tools: [], params: {} },
      harness: session.harness,
      packages,
      config: {},
    };
    emit({ type: "turn.start", turn: turn.id, session: session.id });
    this.journal.append({ kind: "turn.start", actor: session.user, target: session.id, data: { turn: turn.id } });
    // Written now, with the input, so a turn cut short still leaves what was asked; `turn` marks it in progress.
    session.turn = { id: turn.id, startedAt: now(), input: input.filter((m) => m.role === "user").map((m) => contentText(m.content)).join("\n"), messages: input };
    delete session.interrupted;
    session.conversation = ctx.conversation;
    this.store.save(us.sessions, session);
    try {
      const plan = await this.enumerator.enumerate(us, info, packages);
      for (const step of plan) {
        checkCancelled(signal);
        emit({ type: "step.start", step });
        const started = Date.now();
        const mark = streamed.length;
        let result: unknown;
        try {
          result = await this.runStep(us, step, ctx, emit, signal);
        } catch (err) {
          // The step is gone without a result. A cancel is not this: a cancelled step answers with its partial
          // result. What it streamed is kept, and a tool call it never got to answer is answered with the
          // reason, so the record stays one a provider will take on the next turn.
          ctx.conversation = withStreamed(ctx.conversation, streamed.slice(mark), errorMessage(err));
          throw err;
        }
        this.apply(ctx, result, step.id ?? step.export);
        emit({ type: "step.end", step, ms: Date.now() - started });
      }
      checkCancelled(signal);
    } catch (err) {
      const code = err instanceof CodedError ? err.code : undefined;
      emit({ type: "error", message: errorMessage(err), code });
      if (code !== "cancelled") session.interrupted = { turn: turn.id, at: now(), error: { message: errorMessage(err), ...(code ? { code } : {}) } };
    } finally {
      delete session.turn;
      session.conversation = ctx.conversation;
      session.harness = ctx.harness;
      session.turns += 1;
      session.updatedAt = now();
      this.store.save(us.sessions, session);
      emit({ type: "turn.end", turn: turn.id, session: session.id });
      const data = { turn: turn.id, ms: Date.now() - started, ...(failure ? { error: failure } : {}), reported };
      this.journal.append({ kind: "turn.end", actor: session.user, target: session.id, data });
    }
    return session;
  }

  /**
   * A package step runs inside the fence with its own configuration; the rest of the context is the turn's.
   * Its events are the turn's. The phase goes with it -- an optional field on the operation, as every seam is
   * extended -- because the fence bounds a step by what kind of step it is: `execute` runs the model loop and
   * is legitimately long, and everything else builds a prompt, lists tools or records the call and is not.
   */
  private async runStep(us: Userspace, step: StepRef, ctx: StepContext, emit: Emit, signal?: AbortSignal): Promise<unknown> {
    const config = await this.settings.effective(us, step.package);
    return this.fences.request(us, "step", { package: step.package, export: step.export, phase: step.phase, ctx: { ...ctx, config } }, (e) => emit(parseSchema(TurnEventSchema, e, `step ${step.id ?? step.export} event`, "step")), signal);
  }

  /** Validates a step's mutations before they touch the variables. Invalid results are rejected whole. */
  private apply(ctx: StepContext, raw: unknown, stepId: string): void {
    if (raw == null) return;
    const r = parseSchema(StepResultSchema, raw, `step ${stepId} returned an invalid result`, "step");
    if (r.conversation !== undefined) ctx.conversation = r.conversation;
    if (r.call !== undefined) ctx.call = r.call;
    if (r.harness !== undefined) ctx.harness = r.harness;
  }
}

/** The conversation with what a dead step had streamed, every tool call it left unanswered answered with why. */
function withStreamed(conversation: Message[], streamed: Message[], why: string): Message[] {
  const out = [...conversation, ...streamed];
  const answered = new Set(streamed.filter((m) => m.role === "tool").map((m) => m.toolCallId));
  for (const m of streamed) for (const tc of m.toolCalls ?? []) if (!answered.has(tc.id)) out.push({ role: "tool", content: [{ type: "text", data: { text: `error: the turn was interrupted: ${why}` } }], toolCallId: tc.id, name: tc.name });
  return out;
}
