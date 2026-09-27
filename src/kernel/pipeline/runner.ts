import { StepResultSchema, TurnEventSchema } from "../../contracts/schemas/pipeline.js";
import { parseSchema } from "../../lib/validation.js";
import { contentText, normalizeMessage, textContent } from "../../lib/content.js";
import type { FailureKind, Fences, InterruptedWhy, Message, SessionRecord, StepContext, StepRef, TurnEvent, TurnOptions, Userspace } from "../../contracts/index.js";
import { cancelWhy, CodedError, errorMessage } from "../../lib/error.js";
import { newId, now } from "../../lib/ids.js";
import type { Journal } from "../../lib/journal.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { KernelConfig } from "../config.js";
import type { PackageManager } from "../packages/manager.js";
import type { Settings } from "../settings.js";
import type { Enumerator } from "./enumerator.js";

export type Emit = (event: TurnEvent) => void;

/** How often, at most, a running turn's checkpoint is written: a record is one JSON file of up to megabytes. */
const CHECKPOINT_MS = 1_000;

/** A cancelled signal ends the turn with its reason's own error: a person's Stop, a budget, a reload or a restart. */
export function checkCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof CodedError && signal.reason.code === "cancelled" ? signal.reason : new CodedError("turn cancelled", "cancelled");
}

type Failure = { message: string; code?: string; kind?: FailureKind; retryable?: boolean };

/**
 * Runs one turn: enumerate, dispatch each step into the fence, apply mutations, persist. Every step is a
 * package's, run in the caller's fence; the kernel never makes a model call, so what a step streams through
 * `ctx.emit` is relayed as it is, and `usage`, `yield` and the first `error` are the only events the kernel reads.
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
   *
   * A turn that does not reach its end for a reason other than a person's Stop or a budget leaves
   * `session.interrupted`, saying why, and a turn with no input over such a record is its resume.
   */
  async runTurn(us: Userspace, session: SessionRecord, input: Message[], emitOut: Emit, signal?: AbortSignal, opts: TurnOptions = {}): Promise<SessionRecord> {
    const turn = { id: newId("t"), input };
    const started = Date.now();
    // What the steps reported this turn, summed; it is package-reported, so it is journaled under that name.
    const reported: Record<string, number> = {};
    let failure: Failure | undefined;
    // Set when a step stopped at a round boundary because the installation asked it to (`turns.yielding`).
    let yielded: string | undefined;
    // A turn with no input over an interrupted record continues it. The count of automatic resumes runs on along
    // that chain, so whoever resumes can refuse to do it twice; a turn with input starts a new chain.
    const prev = session.interrupted;
    const resumed = input.length === 0 && prev ? { why: prev.why ?? "failed", from: prev.turn } : undefined;
    const resumes = resumed ? (prev?.resumes ?? 0) + 1 : 0;
    // What the running step has streamed as whole messages: each assistant message, and each tool result
    // as the tool message it becomes. A step that dies -- the fence with it -- returns nothing, and these
    // are then all there is of what the turn said and did. `base` is where the running step's own begin.
    const streamed: Message[] = [];
    let base = 0;
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
    // The checkpoint: the record with what the running step has streamed, at most once a second and once more
    // after the last message, so a process killed outright loses at most the round in flight.
    let savedAt = 0;
    let pending: NodeJS.Timeout | undefined;
    const save = () => {
      pending = undefined;
      savedAt = Date.now();
      if (!session.turn) return;
      session.conversation = ctx.conversation;
      session.turn.streamed = streamed.slice(base);
      this.store.save(us.sessions, session);
    };
    const checkpoint = () => {
      if (!pending) pending = setTimeout(save, Math.max(0, savedAt + CHECKPOINT_MS - Date.now())).unref();
    };
    const emit: Emit = (event) => {
      if (event.type === "usage") for (const [k, v] of Object.entries(event.usage)) reported[k] = (reported[k] ?? 0) + v;
      if (event.type === "error" && !failure) failure = { message: event.message, code: event.code, ...(event.kind ? { kind: event.kind } : {}), ...(event.retryable !== undefined ? { retryable: event.retryable } : {}) };
      if (event.type === "yield") yielded = event.why;
      if (event.type === "message") streamed.push(normalizeMessage(event.message));
      if (event.type === "tool.result") streamed.push({ role: "tool", content: event.content ?? textContent(String(event.result ?? "")), toolCallId: event.id, name: event.name });
      if (event.type === "message" || event.type === "tool.result") checkpoint();
      emitOut(event.type === "message" ? { ...event, message: normalizeMessage(event.message) } : event);
    };
    emit({ type: "turn.start", turn: turn.id, session: session.id, ...(resumed ? { resumed } : {}) });
    this.journal.append({ kind: "turn.start", actor: session.user, target: session.id, data: { turn: turn.id, ...(resumed ? { resumed } : {}) } });
    // Written now, with the input, so a turn cut short still leaves what was asked; `turn` marks it in progress.
    session.turn = { id: turn.id, startedAt: now(), input: input.filter((m) => m.role === "user").map((m) => contentText(m.content)).join("\n"), messages: input, ...(resumes ? { resumes } : {}) };
    delete session.interrupted;
    session.conversation = ctx.conversation;
    this.store.save(us.sessions, session);
    let thrown: Failure | undefined;
    try {
      const plan = await this.enumerator.enumerate(us, info, packages);
      for (const step of plan) {
        checkCancelled(signal);
        emit({ type: "step.start", step });
        const started = Date.now();
        base = streamed.length;
        let result: unknown;
        try {
          result = await this.runStep(us, step, ctx, emit, signal);
        } catch (err) {
          // The step is gone without a result. A cancel is not this: a cancelled step answers with its partial
          // result. What it streamed is kept, and a tool call it never got to answer is answered with the
          // reason, so the record stays one a provider will take on the next turn.
          ctx.conversation = withStreamed(ctx.conversation, streamed.slice(base), errorMessage(err));
          base = streamed.length;
          throw err;
        }
        this.apply(ctx, result, step.id ?? step.export);
        base = streamed.length;
        emit({ type: "step.end", step, ms: Date.now() - started });
      }
      checkCancelled(signal);
    } catch (err) {
      const code = err instanceof CodedError ? err.code : undefined;
      thrown = { message: errorMessage(err), ...(code ? { code } : {}) };
      emit({ type: "error", message: thrown.message, code });
    } finally {
      clearTimeout(pending);
      const why = endedBy(thrown, failure, yielded, signal);
      if (why && why !== "stop" && why !== "budget") {
        const error = why === "yield" ? { message: `the turn stopped at a round boundary for a ${yielded}`, code: "yield" } : why === "provider" ? failure! : thrown!;
        session.interrupted = { turn: turn.id, at: now(), error, why, ...(why === "yield" ? { clean: true } : {}), ...(resumes ? { resumes } : {}) };
      }
      delete session.turn;
      session.conversation = ctx.conversation;
      session.harness = ctx.harness;
      session.turns += 1;
      session.updatedAt = now();
      this.store.save(us.sessions, session);
      emit({ type: "turn.end", turn: turn.id, session: session.id });
      const data = { turn: turn.id, ms: Date.now() - started, ...(failure ? { error: failure } : {}), reported, ...(why ? { why } : {}), model: ctx.call.model };
      this.journal.append({ kind: "turn.end", actor: session.user, target: session.id, data });
    }
    return session;
  }

  /**
   * The boot sweep of one userspace. A record still carrying a `turn` marker was being written by a process
   * that died mid-turn (SIGKILL, OOM, a backstop): nothing will ever close it, so it is closed here as that
   * turn's end would have -- its checkpoint kept, its dangling calls answered, `interrupted` with `why: crash`,
   * and the `turn.end` row the journal never got. Run before any turn can start. Answers the session ids.
   */
  recover(us: Userspace): string[] {
    const closed: string[] = [];
    for (const id of this.store.unfinished(us.sessions)) {
      const session = this.store.load(us.sessions, id);
      const turn = session?.turn;
      if (!session || !turn) continue;
      const error = { message: "Thetis stopped while this turn was running", code: "interrupted" };
      session.conversation = withStreamed(session.conversation, turn.streamed ?? [], error.message);
      session.interrupted = { turn: turn.id, at: now(), error, why: "crash", ...(turn.resumes ? { resumes: turn.resumes } : {}) };
      delete session.turn;
      session.turns += 1;
      session.updatedAt = now();
      this.store.save(us.sessions, session);
      const ms = Math.max(0, Date.now() - Date.parse(turn.startedAt)) || 0;
      this.journal.append({ kind: "turn.end", actor: session.user, target: session.id, data: { turn: turn.id, ms, error, reported: {}, why: "crash" } });
      closed.push(id);
    }
    return closed;
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

/**
 * Why a turn ended short of its end, for the record and the journal; undefined when it ran to its end. A
 * throw is a cancel (with its reason) or a failed step; a clean yield wins over a cancel that came after it;
 * a turn that returned normally after a provider error ends `provider`.
 */
function endedBy(thrown: Failure | undefined, failure: Failure | undefined, yielded: string | undefined, signal?: AbortSignal): InterruptedWhy | "stop" | "budget" | undefined {
  if (thrown && thrown.code !== "cancelled") return "failed";
  if (yielded) return "yield";
  if (thrown) return cancelWhy(signal);
  return failure?.code === "provider" ? "provider" : undefined;
}

/** The conversation with what a dead step had streamed, every tool call it left unanswered answered with why. */
function withStreamed(conversation: Message[], streamed: Message[], why: string): Message[] {
  const out = [...conversation, ...streamed];
  const answered = new Set(streamed.filter((m) => m.role === "tool").map((m) => m.toolCallId));
  for (const m of streamed) for (const tc of m.toolCalls ?? []) if (!answered.has(tc.id)) out.push({ role: "tool", content: [{ type: "text", data: { text: `error: the turn was interrupted: ${why}` } }], toolCallId: tc.id, name: tc.name });
  return out;
}
