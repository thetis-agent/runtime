import { z } from "zod";
import { CodedError } from "./error.js";

/** Parse unknown boundary data, retaining the caller's error category without echoing payload values. */
export function parseSchema<S extends z.ZodType>(schema: S, value: unknown, context: string, code = "invalid"): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const details = result.error.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`).join("; ");
  throw new CodedError(`${context}: ${details}`, code);
}
