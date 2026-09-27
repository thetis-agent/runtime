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

/** Why a turn was cancelled, as the signal carries it. Mirrors `CancelWhy` in the contracts. */
export type CancelReason = "stop" | "budget" | "reload" | "restart";

const CANCEL_SAYS: Record<CancelReason, string> = {
  stop: "turn cancelled",
  budget: "turn cancelled: its budget ran out",
  reload: "turn cancelled for a reload of this workspace",
  restart: "turn cancelled for a restart of Thetis",
};

/**
 * What `AbortController.abort` is given for a turn: a `cancelled` error that also says why, so the runner can
 * tell a person's Stop from the installation's reload or restart. `signal.reason.why` is the whole protocol.
 */
export function cancelReason(why: CancelReason): CodedError & { why: CancelReason } {
  return Object.assign(new CodedError(CANCEL_SAYS[why], "cancelled"), { why });
}

/** The reason an aborted signal carries, `stop` when it carries none (an `abort()` with no argument). */
export function cancelWhy(signal?: AbortSignal): CancelReason {
  const why = (signal?.reason as { why?: unknown } | undefined)?.why;
  return why === "budget" || why === "reload" || why === "restart" ? why : "stop";
}
