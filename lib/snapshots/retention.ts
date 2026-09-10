/** Release stopped run workspaces without removing immutable recovery anchors; GN-002, ADR 0046. */
import { readdir, realpath, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';

async function runs(root: string): Promise<Result<{ path: string; entries: string[] }[]>> {
  try {
    if (await realpath(root) !== root) return failure('outside-roots', 'The run workspace root must be canonical.');
  } catch (error) { return isObject(error) && error['code'] === 'ENOENT' ? { ok: true, value: [] } : failure('io', 'The run workspace root could not be inspected.'); }
  try {
    const result = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) return failure('outside-roots', 'The run pool contains a non-directory entry.');
      if (entry.name === 'public') continue;
      const path = join(root, entry.name); const entries = await readdir(path);
      for (const name of entries) {
        if (!['pins', 'state', 'endpoint'].includes(name) || !(await lstat(join(path, name))).isDirectory()) return failure('outside-roots', 'The run workspace contains an unexpected entry.');
      }
      result.push({ path, entries });
    }
    return { ok: true, value: result };
  } catch { return failure('io', 'The run workspaces could not be inspected.'); }
}

export async function activeRuns(root: string): Promise<Result<number>> {
  const listed = await runs(root); if (!listed.ok) return listed;
  return { ok: true, value: listed.value.filter(run => run.entries.length === 0 || run.entries.some(name => name !== 'pins')).length };
}

export async function retireRuns(root: string, retainedPaths: readonly string[]): Promise<Result<void>> {
  const listed = await runs(root); if (!listed.ok) return listed;
  try {
    for (const run of listed.value) {
      if (retainedPaths.some(path => path === run.path || path.startsWith(`${run.path}/`))) continue;
      if (run.entries.includes('pins')) {
        for (const name of run.entries) if (name !== 'pins') await rm(join(run.path, name), { recursive: true, force: true });
      } else await rm(run.path, { recursive: true, force: true });
    }
    return { ok: true, value: undefined };
  } catch { return failure('io', 'The retired run workspace could not be removed.'); }
}
