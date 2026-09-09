/** Keep typed refusals lightweight at worker and process edges; ADR 0006. */
export type Result<T, C extends string = string> = { ok: true; value: T } | { ok: false; error: { code: C; message: string } };

export function failure<C extends string>(code: C, message: string): { ok: false; error: { code: C; message: string } } {
  return { ok: false, error: { code, message } };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
