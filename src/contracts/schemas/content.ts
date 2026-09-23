import { z } from "zod";
import { ContentJsonSchema, JsonValueSchema, objectEnvelope } from "./json.js";

const PartEnvelopeSchema = z.looseObject({ id: z.string().min(1).optional(), type: z.string().min(1), data: JsonValueSchema });
export const ContentPartSchema = objectEnvelope(PartEnvelopeSchema);
export const TextPartSchema = objectEnvelope(PartEnvelopeSchema.extend({ type: z.literal("text"), data: objectEnvelope(z.object({ text: z.string() }).catchall(JsonValueSchema)) }));
export const AssetPartSchema = objectEnvelope(PartEnvelopeSchema.extend({ type: z.literal("asset"), data: objectEnvelope(z.object({ id: z.string().min(1), mediaType: z.string().min(1), name: z.string().optional() }).catchall(JsonValueSchema)) }));

export const ContentSchema = ContentJsonSchema.pipe(z.array(ContentPartSchema).max(4096)).superRefine((parts, ctx) => {
  const ids = new Set<string>();
  parts.forEach((part, index) => {
    if (part.id === undefined) return;
    if (ids.has(part.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: "content part IDs must be nonempty and unique" });
    ids.add(part.id);
  });
});
export const ContentInputSchema = z.preprocess(
  (value) => typeof value === "string" ? [{ type: "text", data: { text: value } }] : value,
  ContentSchema,
);
export const ToolResultSchema = z.looseObject({ type: z.literal("tool-result"), content: ContentSchema });
const IdentifiedPartSchema = objectEnvelope(PartEnvelopeSchema.extend({ id: z.string().min(1) }));
export const ContentEventSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("content.start"), messageId: z.string().min(1), part: IdentifiedPartSchema }),
  z.looseObject({ type: z.literal("content.delta"), messageId: z.string().min(1), partId: z.string().min(1), delta: JsonValueSchema }),
  z.looseObject({ type: z.literal("content.end"), messageId: z.string().min(1), part: IdentifiedPartSchema }),
]);
export const ExtensionEventSchema = z.looseObject({ type: z.literal("extension"), name: z.string().min(1), data: JsonValueSchema });
