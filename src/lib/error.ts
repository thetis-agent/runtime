/** An error with a short machine-readable code, so a caller can tell failures apart without parsing text. */
export class CodedError extends Error {
  constructor(message: string, readonly code: string = "kernel") {
    super(message);
  }
}

export function assert(cond: unknown, message: string, code = "invalid"): asserts cond {
  if (!cond) throw new CodedError(message, code);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}
