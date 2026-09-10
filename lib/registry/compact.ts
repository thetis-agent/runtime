/** Bound loose-object overhead without deleting refs or unreachable objects; ADR 0007, ADR 0037. */
import { git } from './git.ts';
import type { Result } from '@/lib/result/index.ts';
export const limits = { threads: 1, deltaWindow: 0 };
export async function compact(path: string): Promise<Result<void>> {
  const packed = await git(path, ['repack', '-d', '-l', '-n', `--threads=${String(limits.threads)}`, `--window=${String(limits.deltaWindow)}`]);
  return packed.ok ? { ok: true, value: undefined } : packed;
}
