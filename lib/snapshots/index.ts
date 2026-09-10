/** Bound expensive tree work off the event loop; ADR 0012 §7, GN-002. */
import { failure } from '@/lib/result/index.ts';
import type { Result } from '@/lib/result/index.ts';
import { perform } from './pool.ts';

export function snapshot(path: string, destination?: string): Promise<Result<string>> { return perform(path, destination, 'snapshot'); }
export function verify(path: string): Promise<Result<string>> { return perform(path, undefined, 'verify'); }

export async function changes(path: string, destination: string): Promise<Result<string[]>> {
  const result = await perform(path, destination, 'diff'); if (!result.ok) return result;
  try {
    const value: unknown = JSON.parse(result.value);
    return Array.isArray(value) && value.every((item: unknown): item is string => typeof item === 'string') ? { ok: true, value } : failure('io', 'The state difference result is invalid.');
  } catch { return failure('io', 'The state difference result is invalid.'); }
}
