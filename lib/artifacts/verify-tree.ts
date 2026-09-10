/** Check every source/output pair before a pinned tree enters a sandbox; ADR 0037, GN-002. */
import { join } from 'node:path';
import { paths } from '../snapshots/tree.ts';
import { verified, limits } from './verify.mjs';
import { failure, isObject } from '../result/index.ts';
import type { Result } from '../result/index.ts';
export async function verifyTree(root: string): Promise<Result<string>> {
  const entries = await paths(root); if (!entries.ok) return entries;
  let bytes = 0;
  try {
    const sources = new Set(entries.value.flatMap(entry => entry.endsWith('.ts.artifact.json') ? [entry.slice(0, -'.artifact.json'.length)] : entry.endsWith('.ts.js') ? [entry.slice(0, -'.js'.length)] : []));
    for (const entry of sources) {
      bytes += verified(join(root, entry)).length;
      if (bytes > limits.totalBytes) return failure('budget', 'The execution artifacts exceed their total byte limit.');
    }
    return { ok: true, value: '' };
  } catch (error) {
    return isObject(error) && typeof error['code'] === 'string' && ['budget', 'outside-roots', 'hash-mismatch', 'invalid-args'].includes(error['code'])
      ? failure(error['code'], 'The pinned execution artifacts could not be verified.') : failure('io', 'The pinned execution artifacts are missing or unreadable.');
  }
}
