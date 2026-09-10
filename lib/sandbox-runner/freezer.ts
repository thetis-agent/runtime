/** Wait for the kernel freezer acknowledgment before snapshotting writable state; GN-002, generation invariant 3. */
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clock } from '@/lib/events/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import { failure } from '@/lib/schema/index.ts';

export function freeze(path: string, frozen: boolean, clock: Clock, deadlineMs = 10000): Promise<Result<void, 'io' | 'deadline'>> {
  return state(path, 'frozen', frozen ? 1 : 0, clock, deadlineMs, () => writeFile(join(path, 'cgroup.freeze'), frozen ? '1' : '0'));
}

export async function state(path: string, property: 'frozen' | 'populated', expected: 0 | 1, clock: Clock, deadlineMs = 10000, effect = () => Promise.resolve()): Promise<Result<void, 'io' | 'deadline'>> {
  const timer = new AbortController(); let watcher: FSWatcher | undefined; let wake = (): void => {};
  const status = { expired: false, failed: false };
  const deadline = clock.wait(deadlineMs, timer.signal).then(() => { if (!timer.signal.aborted) { status.expired = true; wake(); } });
  try {
    watcher = watch(join(path, 'cgroup.events'), () => { wake(); });
    watcher.on('error', () => { status.failed = true; wake(); });
    await effect();
    for (;;) {
      const changed = Promise.withResolvers<undefined>(); wake = () => { changed.resolve(undefined); };
      const events = await readFile(join(path, 'cgroup.events'), 'utf8');
      if (status.failed) return failure('io', 'The sandbox cgroup acknowledgment could not be watched.');
      if (status.expired) return failure('deadline', 'The sandbox cgroup exceeded its acknowledgment deadline.');
      if (new RegExp(`^${property} ${String(expected)}$`, 'mu').test(events)) return { ok: true, value: undefined };
      await changed.promise;
    }
  } catch { return failure('io', 'The sandbox cgroup state could not be acknowledged.'); }
  finally { timer.abort(); watcher?.close(); await deadline; }
}
