import type { ContentPart, ContentEvent, ExtensionEvent } from "./content.js";
// One turn: the steps the enumerator schedules, what each step sees, what it may change, and the events a turn emits.
import type { Message, ProviderCall, ToolCall } from "./messages.js";
import type { PackageInfo } from "./packages.js";
import type { SessionInfo } from "./identity.js";

export type HarnessState = Record<string, unknown>;

/** A reference to a step the enumerator scheduled: a package export in a phase. */
export interface StepRef {
  package: string;
  export: string;
  id?: string;
  phase?: string;
}

export interface TurnInfo {
  id: string;
  input: Message[];
}

/**
 * What every step sees. Serialized into the fence; mutations come back as a StepResult. The kernel builds
 * `call` as `{ model, messages: [], tools: [], params: {} }` and never reads it again: shaping it, sending it
 * and running what the model asks for are all steps.
 */
export interface StepContext {
  session: SessionInfo;
  turn: TurnInfo;
  conversation: Message[];
  call: ProviderCall;
  harness: HarnessState;
  packages: PackageInfo[];
  config: Record<string, unknown>;
}

export type StepResult = Partial<Pick<StepContext, "conversation" | "call" | "harness">>;

/** What a caller may set for one turn. */
export interface TurnOptions {
  model?: string;
}

/**
 * What a turn streams. The kernel emits the five about the turn and its steps -- `turn.start`, `step.start`,
 * `step.end`, `error` and `turn.end`; a step emits the rest through
 * `ctx.emit` and the kernel relays them as they are. `usage` is summed into the journal; the first `error`
 * is the turn's failure.
 *
 * `text` and `reasoning` are transient: they are what the answer looked like while it arrived, and the
 * `message` event carries the answer itself. `stall` and `nudge` are transient in the same way: they are what
 * the waiting looked like while it happened, and nothing of them is kept in the conversation except the tool
 * result a cancel writes. `reasoning` is transient twice over, because nothing keeps it at
 * all — a reasoning model's thinking is not part of the message, so a gateway redrawing a saved conversation
 * has no thinking to redraw, and a gateway that does not know the kind can ignore it.
 */
export type TurnEvent =
  | ContentEvent
  | ExtensionEvent
  /** A package has saved a new context snapshot; fetch its body only when inspecting it. */
  | { type: "context.updated" }
  | { type: "turn.start"; turn: string; session: string }
  | { type: "step.start"; step: StepRef }
  | { type: "step.end"; step: StepRef; ms: number }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool.call"; call: ToolCall }
  | { type: "tool.result"; id: string; name: string; result: string; content?: ContentPart[] }
  | { type: "message"; message: Message; usage?: Record<string, number> }
  | { type: "usage"; usage: Record<string, number> }
  /**
   * Something in this turn has gone quiet for long enough to ask about. It is still running: a stall is not a
   * failure and not a stop, it is the moment the turn stopped waiting silently and started asking. Every
   * `stall` is followed by exactly one `nudge` for the same `what.id`, unless the work finishes first.
   */
  | { type: "stall"; what: { kind: "tool" | "model"; id: string; name: string }; ms: number }
  /**
   * What was decided about a stall, and who decided it. `by: "model"` is an answer somebody gave; `by: "rule"`
   * is the unanswerable case -- the question could not be put, or could not be answered inside its own budget --
   * and then the decision is always `cancel`, because continuing to wait must never be what happens when nobody
   * chose. `why` says which of those it was, in words a person can read.
   */
  | {
      type: "nudge";
      what: { kind: "tool" | "model"; id: string; name: string };
      ms: number;
      decision: "continue" | "cancel";
      by: "model" | "rule";
      why: string;
    }
  | { type: "error"; message: string; code?: string }
  | { type: "turn.end"; turn: string; session: string };

/** One turn event of one session of a person, as `sessions.watch` reports it. */
export interface WatchedTurnEvent {
  session: string;
  /** The parent session, when the session is a subagent. */
  parent?: string;
  /** On `turn.start` only: a text projection of the turn input. */
  input?: string;
  /** On turn.start only: the complete canonical input. */
  messages?: Message[];
  /** On `turn.start` only: when the turn started. */
  startedAt?: string;
  event: TurnEvent;
}
