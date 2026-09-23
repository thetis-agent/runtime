import type { AssetPart, ContentPart, JsonValue, Message, TextPart, TurnInput } from "../contracts/index.js";
import { CodedError } from "./error.js";

const ROLES = new Set(["system", "user", "assistant", "tool"]);
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 64;

export const textPart = (text: string): TextPart => ({ type: "text", data: { text } });
export const textContent = (text: string): ContentPart[] => [textPart(text)];

export function isTextPart(part: ContentPart): part is TextPart {
  return part.type === "text" && isObject(part.data) && typeof part.data.text === "string";
}

export function isAssetPart(part: ContentPart): part is AssetPart {
  return part.type === "asset" && isObject(part.data) && typeof part.data.id === "string" && typeof part.data.mediaType === "string";
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

export function assertJson(value: unknown, depth = 0, parents = new Set<object>()): asserts value is JsonValue {
  if (depth > MAX_DEPTH) invalid("content is nested too deeply");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || !value || parents.has(value)) invalid("content must be finite, acyclic JSON");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid("content must contain plain JSON objects");
  if (Object.getOwnPropertySymbols(value).length) invalid("content cannot contain symbol keys");
  if (Array.isArray(value) && (Object.keys(value).length !== value.length || Object.keys(value).some((key, index) => key !== String(index)))) invalid("content arrays must be dense and contain only indexed elements");
  parents.add(value);
  for (const entry of Object.values(value)) assertJson(entry, depth + 1, parents);
  parents.delete(value);
}

/** Validates the envelope only. It does not enumerate or rewrite content kinds. */
export function normalizeContent(value: unknown): ContentPart[] {
  if (typeof value === "string") value = textContent(value);
  if (!Array.isArray(value) || value.length > 4096) invalid("content must be an array of parts");
  const ids = new Set<string>();
  for (const part of value) {
    if (!isObject(part) || typeof part.type !== "string" || !part.type || !("data" in part)) invalid("a content part needs type and data");
    if (part.id !== undefined) {
      if (typeof part.id !== "string" || !part.id || ids.has(part.id)) invalid("content part IDs must be nonempty and unique");
      ids.add(part.id);
    }
  }
  return copyJson(value) as unknown as ContentPart[];
}

export function normalizeMessage(value: unknown): Message {
  if (!isObject(value) || typeof value.role !== "string" || !ROLES.has(value.role)) invalid("invalid message role");
  if (value.id !== undefined && (typeof value.id !== "string" || !value.id)) invalid("message ID must be nonempty text");
  if (value.extensions !== undefined && !isObject(value.extensions)) invalid("message extensions must be an object");
  const message = { ...value, content: normalizeContent(value.content) };
  // Optional envelope properties may be omitted by callers before serialization.
  for (const key of Object.keys(message)) if ((message as Record<string, unknown>)[key] === undefined) delete (message as Record<string, unknown>)[key];
  return copyJson(message) as unknown as Message;
}

export function normalizeMessages(value: unknown): Message[] {
  if (!Array.isArray(value) || value.length > 100_000) invalid("messages must be an array");
  return value.map(normalizeMessage);
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

function copyJson(value: unknown): JsonValue {
  assertJson(value);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > MAX_BYTES) invalid("content exceeds the 16 MiB envelope limit; use asset references");
  return JSON.parse(json) as JsonValue;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new CodedError(message, "invalid");
}
