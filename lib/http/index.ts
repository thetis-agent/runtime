/** Bound shared HTTP mechanics while keeping identity and act policy at each owning edge; ADR 0009, ADR 0018. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { failure } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';
export async function bytes(request: IncomingMessage, limit: number, label: string): Promise<Result<Buffer>> {
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const value: unknown = chunk; if (!Buffer.isBuffer(value)) throw new Error('The HTTP byte stream returned non-bytes.');
    total += value.length; if (total > limit) return failure('frame-too-large', `${label} exceeds its byte limit.`);
    chunks.push(value);
  }
  return { ok: true, value: Buffer.concat(chunks) };
}
export async function body(request: IncomingMessage, limit: number, label: string): Promise<Result<unknown>> {
  const read = await bytes(request, limit, label); if (!read.ok) return read;
  try { const value: unknown = JSON.parse(read.value.toString('utf8')); return { ok: true, value }; }
  catch { return failure('invalid-args', `${label} has invalid JSON.`); }
}
/** Same-origin, single-slash redirect targets only; a person's own run names where it goes, never a
 * request-supplied host or escape; ADR 0038 §4. */
export function safeRedirectPath(value: unknown, limitBytes: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return undefined;
  return Buffer.byteLength(value, 'utf8') <= limitBytes ? value : undefined;
}
/** The raw cookie value only, undecoded: callers own how (and whether) to decode it, and this never
 * returns the rest of the header so nothing downstream can log it whole. */
export function cookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const trimmed = part.trim(); const equals = trimmed.indexOf('=');
    if (equals !== -1 && trimmed.slice(0, equals) === name) return trimmed.slice(equals + 1);
  }
  return undefined;
}
export function reply(response: ServerResponse, result: Result<unknown>): void {
  response.writeHead(result.ok ? 200 : result.error.code === 'auth' ? 401 : result.error.code === 'budget' ? 429 : 400, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", connection: 'close' });
  response.end(JSON.stringify(result));
}
