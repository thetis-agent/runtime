import { z } from "zod";
import { ContentEventSchema, ContentSchema, ExtensionEventSchema } from "./content.js";
import { MessageInputSchema, MessagesInputSchema, ProviderCallInputSchema, ToolCallSchema, UsageSchema } from "./messages.js";

export const StepRefSchema = z.looseObject({ package: z.string().min(1), export: z.string().min(1), id: z.string().min(1).optional(), phase: z.string().min(1).optional() });
export const StepPlanSchema = z.array(StepRefSchema);
export const StepResultSchema = z.looseObject({
  conversation: MessagesInputSchema.optional(), call: ProviderCallInputSchema.optional(), harness: z.record(z.string(), z.unknown()).optional(),
});
const StallTargetSchema = z.looseObject({ kind: z.enum(["tool", "model"]), id: z.string(), name: z.string() });
export const TurnEventSchema = z.discriminatedUnion("type", [
  ContentEventSchema, ExtensionEventSchema,
  z.looseObject({ type: z.literal("context.updated") }),
  z.looseObject({ type: z.literal("turn.start"), turn: z.string(), session: z.string() }),
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
  z.looseObject({ type: z.literal("error"), message: z.string(), code: z.string().optional() }),
  z.looseObject({ type: z.literal("turn.end"), turn: z.string(), session: z.string() }),
]);
export const WatchedTurnEventSchema = z.looseObject({
  session: z.string(), parent: z.string().optional(), input: z.string().optional(), messages: MessagesInputSchema.optional(), startedAt: z.string().optional(), event: TurnEventSchema,
});
