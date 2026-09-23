import type { AssetPart, ContentPart, JsonValue, Message, TextPart, TurnInput } from "../contracts/index.js";
import { AssetPartSchema, ContentInputSchema, JsonValueSchema, MessageInputSchema, MessagesInputSchema, TextPartSchema } from "../contracts/schemas/index.js";
import { parseSchema } from "./validation.js";

export const textPart = (text: string): TextPart => ({ type: "text", data: { text } });
export const textContent = (text: string): ContentPart[] => [textPart(text)];

export function isTextPart(part: unknown): part is TextPart {
  return TextPartSchema.safeParse(part).success;
}

export function isAssetPart(part: unknown): part is AssetPart {
  return AssetPartSchema.safeParse(part).success;
}

export function assetPart(id: string, mediaType: string, name?: string): AssetPart {
  return { type: "asset", data: { id, mediaType, ...(name === undefined ? {} : { name }) } };
}

/** A deliberately lossy text projection for previews, search and text-only callers. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part): part is TextPart => !!part && isTextPart(part)).map((part) => part.data.text).join("");
}

export function assertJson(value: unknown): asserts value is JsonValue {
  parseSchema(JsonValueSchema, value, "invalid JSON");
}

/** Validates the envelope only. It does not enumerate or rewrite content kinds. */
export function normalizeContent(value: unknown): ContentPart[] {
  return parseSchema(ContentInputSchema, value, "invalid content");
}

export function normalizeMessage(value: unknown): Message {
  return parseSchema(MessageInputSchema, value, "invalid message");
}

export function normalizeMessages(value: unknown): Message[] {
  return parseSchema(MessagesInputSchema, value, "invalid messages");
}

export function normalizeTurnInput(value: TurnInput | unknown): Message[] {
  if (typeof value === "string") return [normalizeMessage({ role: "user", content: value })];
  return normalizeMessages(Array.isArray(value) ? value : [value]);
}

/** Canonical rich results opt in; arbitrary legacy objects keep their JSON-text behavior. */
export function toolContent(value: unknown): ContentPart[] {
  if (isObject(value) && value.type === "tool-result") return normalizeContent(value.content);
  return textContent(typeof value === "string" ? value : JSON.stringify(value ?? null));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
