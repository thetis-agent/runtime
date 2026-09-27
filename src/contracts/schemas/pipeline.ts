import { z } from "zod";
import { ContentEventSchema, ContentSchema, ExtensionEventSchema } from "./content.js";
import { FailureFieldsShape, MessageInputSchema, MessagesInputSchema, ProviderCallInputSchema, ToolCallSchema, UsageSchema } from "./messages.js";

export const StepRefSchema = z.looseObject({ package: z.string().min(1), export: z.string().min(1), id: z.string().min(1).optional(), phase: z.string().min(1).optional() });
export const StepPlanSchema = z.array(StepRefSchema);
export const StepResultSchema = z.looseObject({
  conversation: MessagesInputSchema.optional(), call: ProviderCallInputSchema.optional(), harness: z.record(z.string(), z.unknown()).optional(),
});
const StallTargetSchema = z.looseObject({ kind: z.enum(["tool", "model"]), id: z.string(), name: z.string() });
export const TurnEventSchema = z.discriminatedUnion("type", [
  ContentEventSchema, ExtensionEventSchema,
  z.looseObject({ type: z.literal("context.updated") }),
  // `resumed`: a turn with no input over a record that was interrupted, and why that one stopped.
  z.looseObject({ type: z.literal("turn.start"), turn: z.string(), session: z.string(), resumed: z.looseObject({ why: z.string(), from: z.string(), for: z.string().optional() }).optional() }),
  z.looseObject({ type: z.literal("step.start"), step: StepRefSchema }),
  z.looseObject({ type: z.literal("step.end"), step: StepRefSchema, ms: z.number().nonnegative() }),
  z.looseObject({ type: z.literal("text"), delta: z.string() }),
  z.looseObject({ type: z.literal("reasoning"), delta: z.string() }),
  z.looseObject({ type: z.literal("tool.call"), call: ToolCallSchema }),
  z.looseObject({ type: z.literal("tool.result"), id: z.string(), name: z.string(), result: z.string(), content: ContentSchema.optional() }),
  z.looseObject({ type: z.literal("message"), message: MessageInputSchema, usage: UsageSchema.optional() }),
  z.looseObject({ type: z.literal("usage"), usage: UsageSchema }),
  z.looseObject({ type: z.literal("stall"), what: StallTargetSchema, ms: z.number().nonnegative() }),
  z.looseObject({ type: z.literal("nudge"), what: StallTargetSchema, ms: z.number().nonnegative(), decision: z.enum(["continue", "cancel"]), by: z.enum(["model", "rule"]), why: z.string() }),
  z.looseObject({ type: z.literal("error"), message: z.string(), code: z.string().optional(), ...FailureFieldsShape }),
  // The step stopped at a round boundary because the installation asked it to (`turns.yielding()`): nothing is partial.
  z.looseObject({ type: z.literal("yield"), why: z.string() }),
  z.looseObject({ type: z.literal("turn.end"), turn: z.string(), session: z.string() }),
]);
export const WatchedTurnEventSchema = z.looseObject({
  session: z.string(), parent: z.string().optional(), input: z.string().optional(), messages: MessagesInputSchema.optional(), startedAt: z.string().optional(), event: TurnEventSchema,
});
