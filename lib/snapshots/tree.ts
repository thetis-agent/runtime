/** Hash bounded trees in a worker, refusing symlinks and concurrent file changes; GN-002, KS-010. */
import { createHash } from 'node:crypto';
import { opendir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileChunks } from '../ndjson/file.ts';
import { failure } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';

export const limits = { entries: 10000, bytes: 1024 * 1024 * 1024, depth: 64, workers: 2 };
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

export async function hashTree(path: string): Promise<Result<string>> {
  try {
    if (!(await lstat(path)).isDirectory()) return failure('outside-roots', 'The snapshot root is not a directory.');
    const entries = await listing(path, '', { entries: limits.entries }, 0); if (!entries.ok) return entries;
    const hash = createHash('sha256'); let remaining = limits.bytes;
    for (const name of entries.value.sort()) {
      const file = join(path, name); const before = await lstat(file);
      if (before.isSymbolicLink() || !before.isDirectory() && !before.isFile()) return failure('outside-roots', `${name} changed its snapshot type.`);
      hash.update(JSON.stringify([name, before.isDirectory() ? 'directory' : 'file', before.mode & 0o777, before.isDirectory() ? 0 : before.size]));
      if (before.isFile()) for await (const chunk of fileChunks(file)) {
        remaining -= chunk.length; if (remaining < 0) return failure('budget', 'The snapshot exceeds its byte budget.'); hash.update(chunk);
      }
      const after = await lstat(file);
      if (after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return failure('io', `${name} changed while its snapshot was hashed.`);
    }
    return { ok: true, value: `sha256:${hash.digest('hex')}` };
  } catch { return failure('io', 'The snapshot tree could not be read.'); }
}
