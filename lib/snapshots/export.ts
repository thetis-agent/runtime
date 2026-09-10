/** Export stopped durable stores while refusing links that are not ephemeral endpoints; GN-007. */
import { mkdir, opendir, lstat, realpath, copyFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { hashTree, limits } from './tree.ts';
import { failure } from '../result/index.ts';
import type { Result } from '../result/index.ts';

interface Budget { entries: number; bytes: number }
async function copy(root: string, source: string, destination: string, budget: Budget, depth: number): Promise<Result<void>> {
  if (depth > limits.depth) return failure('budget', 'The durable store exceeds its depth budget.');
  await mkdir(destination, { mode: 0o700 });
  for await (const entry of await opendir(source)) {
    if (--budget.entries < 0) return failure('budget', 'The durable store exceeds its entry budget.');
    const from = join(source, entry.name); const to = join(destination, entry.name); const before = await lstat(from);
    if (before.isSocket()) continue;
    if (before.isSymbolicLink()) {
      const resolved = await realpath(from);
      if (!resolved.startsWith(`${root}/`) || !(await lstat(resolved)).isSocket()) return failure('outside-roots', 'The durable store contains a non-endpoint symlink.');
      continue;
    }
    if (before.isDirectory()) { const nested = await copy(root, from, to, budget, depth + 1); if (!nested.ok) return nested; }
    else if (before.isFile()) {
      budget.bytes -= before.size; if (budget.bytes < 0) return failure('budget', 'The durable store exceeds its byte budget.');
      await copyFile(from, to); await chmod(to, before.mode & 0o777);
    } else return failure('outside-roots', 'The durable store contains a non-regular entry.');
    const after = await lstat(from);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return failure('io', 'The durable store changed during export.');
  }
  await chmod(destination, (await lstat(source)).mode & 0o777);
  return { ok: true, value: undefined };
}

export async function exportStore(source: string, destination: string): Promise<Result<string>> {
  try {
    const root = await realpath(source);
    if (root !== source || destination === root || destination.startsWith(`${root}/`)) return failure('outside-roots', 'The durable store export requires separate canonical roots.');
    const copied = await copy(root, root, destination, { entries: limits.entries, bytes: limits.bytes }, 0);
    return copied.ok ? await hashTree(destination) : copied;
  } catch { return failure('io', 'The stopped durable store could not be exported.'); }
}
