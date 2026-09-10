/** Copy fixtures by hash before seeded mutation and never mount suite metadata; EV-001, EV-002. */
import { Worker } from 'node:worker_threads';
import { snapshot } from '../snapshots/index.ts';
import { failure, isObject } from '../result/index.ts';
import type { Result } from '../result/index.ts';
export const fixtureLimits = { workers: 2, fileBytes: 1048576 };
let active = 0;
export async function fixture(source: string, hash: string, destination: string, mutation: Readonly<Record<string, string>>): Promise<Result<string>> {
  if (active >= fixtureLimits.workers) return failure('budget', 'The fixture mutation worker pool is full.');
  active++;
  try {
    const copied = await snapshot(source, destination); if (!copied.ok) return copied;
    if (copied.value !== hash) return failure('hash-mismatch', 'The task fixture does not match its authorized hash.');
    return await new Promise(resolve => {
      const worker = new Worker(new URL('./fixture-worker.ts', import.meta.url), { workerData: { path: destination, mutation } });
      let result: Result<string> = failure('io', 'The fixture worker exited without a result.');
      worker.once('message', (value: unknown) => {
        if (isObject(value) && value['ok'] === true && typeof value['value'] === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value['value'])) result = { ok: true, value: value['value'] };
        else if (isObject(value) && isObject(value['error']) && typeof value['error']['code'] === 'string' && typeof value['error']['message'] === 'string') result = failure(value['error']['code'], value['error']['message']);
      });
      worker.once('error', () => { result = failure('io', 'The fixture worker failed.'); });
      worker.once('exit', () => { resolve(result); });
    });
  } catch { return failure('io', 'The fixture could not be prepared.'); }
  finally { active--; }
}
