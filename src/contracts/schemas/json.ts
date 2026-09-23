import { z } from "zod";

/** Validate the complete JSON graph, including cycles, depth, prototypes and sparse arrays. */
function jsonProblem(value: unknown, depth = 0, parents = new Set<object>()): string | undefined {
  if (depth > 64) return "content is nested too deeply";
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || !value || parents.has(value)) return "content must be finite, acyclic JSON";
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return "content must contain plain JSON objects";
  if (Object.getOwnPropertySymbols(value).length) return "content cannot contain symbol keys";
  if (Array.isArray(value) && (Object.keys(value).length !== value.length || Object.keys(value).some((key, index) => key !== String(index)))) return "content arrays must be dense and contain only indexed elements";
  parents.add(value);
  for (const entry of Object.values(value)) {
    const problem = jsonProblem(entry, depth + 1, parents);
    if (problem) return problem;
  }
  parents.delete(value);
}

type JsonValue = z.infer<ReturnType<typeof z.json>>;

// The built-in JSON parser strips own __proto__ keys. Validate every value before cloning so opaque
// payloads retain those keys as data without assigning them through an object's prototype setter.
export const JsonValueSchema = z.custom<JsonValue>(
  (value) => jsonProblem(value) === undefined,
  { error: (issue) => jsonProblem(issue.input) ?? "invalid JSON" },
).transform((value, ctx) => {
  try {
    const snapshot = structuredClone(value);
    const problem = jsonProblem(snapshot);
    if (!problem) return snapshot;
    ctx.addIssue({ code: "custom", message: problem });
  } catch {
    ctx.addIssue({ code: "custom", message: "content must be cloneable JSON" });
  }
  return z.NEVER;
});

/** Zod strips this key from object envelopes; refuse it explicitly instead of losing user data. */
export function objectEnvelope<S extends z.ZodType>(schema: S) {
  return z.preprocess((value, ctx) => {
    if (value && typeof value === "object" && Object.hasOwn(value, "__proto__")) {
      ctx.addIssue({ code: "custom", path: ["__proto__"], message: "__proto__ is reserved in an envelope; put opaque JSON in data" });
      return z.NEVER;
    }
    return value;
  }, schema);
}

/** Serialized content stays small; binary bodies travel through asset references. */
export const ContentJsonSchema = JsonValueSchema.refine(
  (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 16 * 1024 * 1024,
  "content exceeds the 16 MiB envelope limit; use asset references",
).transform((value): unknown => value);
