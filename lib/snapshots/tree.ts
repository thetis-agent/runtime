/** Hash bounded trees in a worker, refusing symlinks and concurrent file changes; GN-002, KS-010. */
import { createHash } from 'node:crypto';
import type { Hash } from 'node:crypto';
import { opendir, lstat } from 'node:fs/promises';
import { constants, openSync, closeSync, readSync, lstatSync, fstatSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { isMainThread } from 'node:worker_threads';
import { join } from 'node:path';
import { failure } from '@/lib/result/index.ts';
import type { Result } from '@/lib/result/index.ts';

export const limits = { entries: 10000, bytes: 1024 * 1024 * 1024, chunkBytes: 65536, depth: 64, workers: 2, workerOldMiB: 16, workerYoungMiB: 2, workerStackMiB: 2, changeBytes: 61440 };
async function listing(path: string, prefix: string, remaining: { entries: number }, depth: number): Promise<Result<string[]>> {
  if (depth > limits.depth) return failure('budget', 'The snapshot exceeds its depth budget.');
  const paths: string[] = [];
  for await (const entry of await opendir(path)) {
    if (--remaining.entries < 0) return failure('budget', 'The snapshot exceeds its entry budget.');
    const name = join(prefix, entry.name); paths.push(name);
    if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) return failure('outside-roots', `${name} is not a regular snapshot entry.`);
    if (entry.isDirectory()) {
      const nested = await listing(join(path, entry.name), name, remaining, depth + 1);
      if (!nested.ok) return nested; paths.push(...nested.value);
    }
  }
  return { ok: true, value: paths };
}

export async function paths(path: string): Promise<Result<string[]>> {
  try {
    if (!(await lstat(path)).isDirectory()) return failure('outside-roots', 'The snapshot root is not a directory.');
    return await listing(path, '', { entries: limits.entries }, 0);
  } catch { return failure('io', 'The snapshot entries could not be read.'); }
}

export async function hashTree(path: string, maximumEntries = limits.entries): Promise<Result<string>> {
  if (isMainThread) return failure('invalid-args', 'Snapshot hashing requires a bounded worker.');
  try {
    if (!(await lstat(path)).isDirectory()) return failure('outside-roots', 'The snapshot root is not a directory.');
    const entries = await listing(path, '', { entries: maximumEntries }, 0); if (!entries.ok) return entries;
    const hash = createHash('sha256'); const budget = { remaining: limits.bytes, buffer: Buffer.alloc(limits.chunkBytes) };
    for (const name of entries.value.sort()) {
      const file = join(path, name); const before = lstatSync(file);
      if (before.isSymbolicLink() || !before.isDirectory() && !before.isFile()) return failure('outside-roots', `${name} changed its snapshot type.`);
      hash.update(JSON.stringify([name, before.isDirectory() ? 'directory' : 'file', before.mode & 0o777, before.isDirectory() ? 0 : before.size]));
      if (before.isFile()) { const read = hashFile(file, before, hash, budget); if (!read.ok) return read; }
      if (!unchanged(before, lstatSync(file))) return failure('io', `${name} changed while its snapshot was hashed.`);
    }
    return { ok: true, value: `sha256:${hash.digest('hex')}` };
  } catch { return failure('io', 'The snapshot tree could not be read.'); }
}

function unchanged(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

function hashFile(path: string, before: Stats, hash: Hash, budget: { remaining: number; buffer: Buffer }): Result<void> {
  if (before.size > budget.remaining) return failure('budget', 'The snapshot exceeds its byte budget.');
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!unchanged(before, fstatSync(descriptor))) return failure('io', 'The snapshot file changed before its read.');
    let total = 0;
    for (;;) {
      const count = readSync(descriptor, budget.buffer, 0, budget.buffer.length, null); if (!count) break;
      total += count; budget.remaining -= count;
      if (budget.remaining < 0) return failure('budget', 'The snapshot exceeds its byte budget.');
      hash.update(budget.buffer.subarray(0, count));
    }
    return total === before.size && unchanged(before, fstatSync(descriptor)) ? { ok: true, value: undefined } : failure('io', 'The snapshot file changed during its read.');
  } finally { closeSync(descriptor); }
}
