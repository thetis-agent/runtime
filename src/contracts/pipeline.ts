import type { z } from "zod";
import type { StepRefSchema, StepResultSchema, TurnEventSchema, WatchedTurnEventSchema } from "./schemas/pipeline.js";
// One turn: the steps the enumerator schedules, what each step sees, what it may change, and the events a turn emits.
import type { Message, ProviderCall } from "./messages.js";
import type { PackageInfo } from "./packages.js";
import type { SessionInfo } from "./identity.js";

export type HarnessState = Record<string, unknown>;

/** A reference to a step the enumerator scheduled: a package export in a phase. */
export type StepRef = z.infer<typeof StepRefSchema>;

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

export type StepResult = z.infer<typeof StepResultSchema>;

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
export type TurnEvent = z.infer<typeof TurnEventSchema>;

/** One turn event of one session of a person, as `sessions.watch` reports it. */
export type WatchedTurnEvent = z.infer<typeof WatchedTurnEventSchema>;
