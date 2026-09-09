/** Wait for the kernel freezer acknowledgment before snapshotting writable state; GN-002, generation invariant 3. */
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clock } from '../events/index.ts';
import type { Result } from '../schema/index.ts';
import { failure } from '../schema/index.ts';

export async function freeze(path: string, frozen: boolean, clock: Clock, deadlineMs = 10000): Promise<Result<void, 'io' | 'deadline'>> {
  const timer = new AbortController(); let watcher: FSWatcher | undefined; let wake = (): void => {};
  const status = { expired: false, failed: false };
  const deadline = clock.wait(deadlineMs, timer.signal).then(() => { if (!timer.signal.aborted) { status.expired = true; wake(); } });
  try {
    watcher = watch(join(path, 'cgroup.events'), () => { wake(); });
    watcher.on('error', () => { status.failed = true; wake(); });
    await writeFile(join(path, 'cgroup.freeze'), frozen ? '1' : '0');
    for (;;) {
      const changed = Promise.withResolvers<undefined>(); wake = () => { changed.resolve(undefined); };
      const events = await readFile(join(path, 'cgroup.events'), 'utf8');
      if (status.failed) return failure('io', 'The sandbox freezer acknowledgment could not be watched.');
      if (status.expired) return failure('deadline', 'The sandbox freezer exceeded its deadline.');
      if (new RegExp(`^frozen ${frozen ? '1' : '0'}$`, 'mu').test(events)) return { ok: true, value: undefined };
      await changed.promise;
    }
  } catch { return failure('io', 'The sandbox freezer could not be changed.'); }
  finally { timer.abort(); watcher?.close(); await deadline; }
}
