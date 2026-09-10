/** Mutate only a verified private copy, keeping fixture work off the loop; EV-001, EV-002. */
import { parentPort, workerData } from 'node:worker_threads';
import { lstat, chmod, rename, writeFile } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { paths, hashTree } from '@/lib/snapshots/tree.ts';
import { readBounded } from '@/lib/files/read-bounded.ts';
import { Schemas } from '@/lib/schema/index.ts';
import { failure } from '@/lib/result/index.ts';
import type { Result } from '@/lib/result/index.ts';
import schema from '@/contracts/evaluator/schema.json' with { type: 'json' };
import type { FixtureWork } from '@/contracts/evaluator/types.ts';
import { replace } from './replace.ts';
const check = new Schemas().compile<FixtureWork>({ ...schema, $id: 'thetis://worker/fixture/1', $ref: '#/$defs/fixtureWork' });

async function transform(input: FixtureWork): Promise<Result<string>> {
  const entries = await paths(input.path); if (!entries.ok) return entries;
  const names: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.mutation)) {
    names[key] = basename(value);
    if (key.startsWith('{') && key.endsWith('}')) names[key.slice(1, -1)] = basename(value);
  }
  for (const name of entries.value.sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b))) {
    const path = join(input.path, name); const info = await lstat(path);
    if (info.isFile()) {
      const file = await readBounded(path, 1048576); if (!file.ok) return file;
      let text: string | undefined;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(file.value); } catch { text = undefined; }
      if (text !== undefined) {
        await chmod(path, info.mode | 0o200); await writeFile(path, replace(text, input.mutation)); await chmod(path, info.mode & 0o777);
      }
    }
    const changed = replace(basename(name), names);
    if (changed === '.' || changed === '..' || changed.includes('/') || changed.includes('\0')) return failure('outside-roots', 'A fixture mutation escapes its directory.');
    if (changed !== basename(name)) {
      const target = join(dirname(path), changed);
      try { await lstat(target); return failure('invalid-args', 'A fixture mutation collides with another path.'); }
      catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') return failure('io', 'A mutated fixture path could not be inspected.'); }
      await rename(path, target);
    }
  }
  return hashTree(input.path);
}
const input: unknown = workerData;
try { parentPort?.postMessage(check(input) ? await transform(input) : failure('invalid-args', 'The fixture worker input violates its schema.')); }
catch { parentPort?.postMessage(failure('io', 'The fixture mutation could not be committed.')); }
