/** Bound expensive tree work off the event loop; ADR 0012 §7, GN-002. */
import { Worker } from 'node:worker_threads';
import { failure, isObject } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';
import { limits } from './tree.ts';
let active = 0;

export async function snapshot(path: string, destination?: string): Promise<Result<string>> {
  if (active >= limits.workers) return failure('budget', 'The snapshot worker pool is full.');
  active++;
  try {
    return await new Promise<Result<string>>(resolve => {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { workerData: { path, destination } });
      let answer: Result<string> = failure('io', 'The snapshot worker exited without a result.');
      worker.once('message', (message: unknown) => {
        if (!isObject(message)) return;
        if (message['ok'] === true && typeof message['value'] === 'string') answer = { ok: true, value: message['value'] };
        else if (message['ok'] === false && isObject(message['error']) && typeof message['error']['code'] === 'string' && typeof message['error']['message'] === 'string') answer = failure(message['error']['code'], message['error']['message']);
      });
      worker.once('error', () => { answer = failure('io', 'The snapshot worker failed.'); });
      worker.once('exit', code => { resolve(code === 0 ? answer : failure('io', 'The snapshot worker did not complete.')); });
    });
  } catch { return failure('io', 'The snapshot worker could not be started.'); }
  finally { active--; }
}
