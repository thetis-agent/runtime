/** List changed state paths off the event loop and bound their audit row; GN-006. */
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileChunks } from '@/lib/ndjson/file.ts';
import { paths, limits } from './tree.ts';
import { failure } from '@/lib/result/index.ts';
import type { Result } from '@/lib/result/index.ts';

async function signatures(root: string): Promise<Result<Map<string, string>>> {
  const listed = await paths(root); if (!listed.ok) return listed;
  const result = new Map<string, string>(); let remaining = limits.bytes;
  try {
    for (const name of listed.value) {
      const path = join(root, name); const before = await lstat(path);
      if (!before.isDirectory() && !before.isFile()) return failure('outside-roots', `${name} is not a regular state entry.`);
      const hash = createHash('sha256').update(JSON.stringify([before.mode & 0o777, before.isDirectory() ? 'directory' : 'file']));
      if (before.isFile()) for await (const chunk of fileChunks(path)) {
        remaining -= chunk.length; if (remaining < 0) return failure('budget', 'The compared state exceeds its byte limit.'); hash.update(chunk);
      }
      const after = await lstat(path);
      if (after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.size !== before.size) return failure('io', `${name} changed during state comparison.`);
      result.set(name, hash.digest('hex'));
    }
    return { ok: true, value: result };
  } catch { return failure('io', 'The state entries could not be compared.'); }
}

export async function differences(before: string, after: string): Promise<Result<string>> {
  const old = await signatures(before); if (!old.ok) return old;
  const next = await signatures(after); if (!next.ok) return next;
  const names = [...new Set([...old.value.keys(), ...next.value.keys()])].sort().filter(name => old.value.get(name) !== next.value.get(name));
  const value = JSON.stringify(names);
  return Buffer.byteLength(value) <= limits.changeBytes ? { ok: true, value } : failure('budget', 'The state change list exceeds its byte limit.');
}
