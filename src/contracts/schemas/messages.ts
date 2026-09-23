import { z } from "zod";
import { ContentSchema, ContentInputSchema, ContentEventSchema, ExtensionEventSchema } from "./content.js";
import { ContentJsonSchema, JsonValueSchema, objectEnvelope } from "./json.js";

export const RoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export const ToolCallSchema = z.looseObject({ id: z.string(), name: z.string(), args: objectEnvelope(z.record(z.string(), z.unknown())) });
const MessageEnvelopeSchema = z.looseObject({
  role: RoleSchema,
  id: z.string().min(1).optional(),
  content: ContentSchema,
  extensions: objectEnvelope(z.record(z.string(), JsonValueSchema)).optional(),
  toolCalls: z.array(ToolCallSchema).optional(),
  toolCallId: z.string().optional(),
  name: z.string().optional(),
});

// Optional top-level fields may be explicitly undefined before serialization.
const OmittedOptionalsSchema = z.unknown().transform((value, ctx) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if (Object.getOwnPropertySymbols(value).length) {
    ctx.addIssue({ code: "custom", message: "content cannot contain symbol keys" });
    return z.NEVER;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
});
export const MessageSchema = OmittedOptionalsSchema.pipe(ContentJsonSchema).pipe(objectEnvelope(MessageEnvelopeSchema));
export const MessageInputSchema = OmittedOptionalsSchema.pipe(ContentJsonSchema).pipe(objectEnvelope(MessageEnvelopeSchema.extend({ content: ContentInputSchema })));
export const MessagesInputSchema = z.array(MessageInputSchema).max(100_000);
export const ToolSpecSchema = z.looseObject({
  name: z.string(), description: z.string(), parameters: z.record(z.string(), z.unknown()), package: z.string(), export: z.string(),
});
export const ProviderCallSchema = z.looseObject({
  model: z.string(), system: z.string().optional(), messages: z.array(MessageSchema), tools: z.array(ToolSpecSchema),
  params: z.record(z.string(), z.unknown()), hints: z.record(z.string(), z.unknown()).optional(),
});
export const ProviderCallInputSchema = ProviderCallSchema.extend({
  messages: MessagesInputSchema, tools: z.array(ToolSpecSchema).default([]), params: z.record(z.string(), z.unknown()).default({}),
});
export const UsageSchema = z.record(z.string(), z.number());
export const ProviderEventSchema = z.discriminatedUnion("type", [
  ContentEventSchema, ExtensionEventSchema,
  z.looseObject({ type: z.literal("request"), body: z.record(z.string(), z.unknown()), at: z.string() }),
  z.looseObject({ type: z.literal("text"), delta: z.string() }),
  z.looseObject({ type: z.literal("reasoning"), delta: z.string() }),
  z.looseObject({ type: z.literal("tool_call"), call: ToolCallSchema }),
  z.looseObject({ type: z.literal("usage"), usage: UsageSchema }),
  z.looseObject({ type: z.literal("error"), message: z.string() }),
]);
export const ModelDescriptorSchema = z.looseObject({ id: z.string(), name: z.string().optional(), provider: z.string().optional() });
export const ModelChoicesSchema = z.looseObject({ model: z.string(), models: z.array(ModelDescriptorSchema) });
