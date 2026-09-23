/** JSON carried losslessly across processes. Binary data belongs in the asset store. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** An open content envelope. Packages own the schema of their namespaced types. */
export interface ContentPart {
  id?: string;
  type: string;
  data: JsonValue;
}

export interface TextPart extends ContentPart {
  type: "text";
  data: { text: string };
}

export interface AssetPart extends ContentPart {
  type: "asset";
  data: { id: string; mediaType: string; name?: string };
}

/** Explicit rich tool output, distinct from legacy objects rendered as JSON text. */
export interface ToolResult {
  type: "tool-result";
  content: ContentPart[];
}

/** Legacy strings and objects remain accepted; rich results use the explicit ToolResult envelope. */
export type ToolOutput = ToolResult | string | object;

/** End carries the complete part; arbitrary deltas need not be understood to retain the final result. */
export type ContentEvent =
  | { type: "content.start"; messageId: string; part: ContentPart & { id: string } }
  | { type: "content.delta"; messageId: string; partId: string; delta: JsonValue }
  | { type: "content.end"; messageId: string; part: ContentPart & { id: string } };

export interface ExtensionEvent {
  type: "extension";
  name: string;
  data: JsonValue;
}
