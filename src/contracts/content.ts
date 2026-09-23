import type { z } from "zod";
import type { JsonValueSchema } from "./schemas/json.js";
import type { ContentPartSchema, TextPartSchema, AssetPartSchema, ToolResultSchema, ContentEventSchema, ExtensionEventSchema } from "./schemas/content.js";

/** JSON carried losslessly across processes. Binary data belongs in the asset store. */
export type JsonValue = z.infer<typeof JsonValueSchema>;

/** An open content envelope. Packages own the schema of their namespaced types. */
export type ContentPart = z.infer<typeof ContentPartSchema>;

export type TextPart = z.infer<typeof TextPartSchema>;

export type AssetPart = z.infer<typeof AssetPartSchema>;

/** Explicit rich tool output, distinct from legacy objects rendered as JSON text. */
export type ToolResult = z.infer<typeof ToolResultSchema>;

/** Legacy strings and objects remain accepted; rich results use the explicit ToolResult envelope. */
export type ToolOutput = ToolResult | string | object;

/** End carries the complete part; arbitrary deltas need not be understood to retain the final result. */
export type ContentEvent = z.infer<typeof ContentEventSchema>;

export type ExtensionEvent = z.infer<typeof ExtensionEventSchema>;
