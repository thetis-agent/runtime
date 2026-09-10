/** Share only registry-owned immutable blobs; generation and state snapshots remain copies; GN-002, ADR 0037. */
import { mkdir, lstat, link, realpath, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { paths } from './tree.ts';
import { snapshot } from './index.ts';
import { failure } from '../result/index.ts';
import type { Result } from '../result/index.ts';
export async function immutableLinks(source: string, destination: string): Promise<Result<string>> {
  try {
    if (await realpath(source) !== source || await realpath(dirname(destination)) !== dirname(destination) || destination === source || destination.startsWith(`${source}/`)) return failure('outside-roots', 'The immutable cache link requires separate canonical roots.');
    const original = await snapshot(source); if (!original.ok) return original;
    const entries = await paths(source); if (!entries.ok) return entries;
    await mkdir(destination, { mode: (await lstat(source)).mode & 0o777 });
    for (const entry of entries.value.sort()) {
      const from = join(source, entry); const to = join(destination, entry); const info = await lstat(from);
      if (info.isDirectory()) { await mkdir(to); await chmod(to, info.mode & 0o777); }
      else if (info.isFile()) await link(from, to);
      else return failure('outside-roots', 'The immutable cache contains a non-regular entry.');
    }
    const copied = await snapshot(destination);
    return copied.ok && copied.value === original.value ? copied : failure('hash-mismatch', 'The linked immutable cache changed during assembly.');
  } catch { return failure('io', 'The immutable cache could not be linked.'); }
}
