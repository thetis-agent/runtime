/** Reuse bounded workers so repeated review does not retain hundreds of thread arenas; GN-002. */
import { Worker } from 'node:worker_threads';
import { failure, isObject } from '@/lib/result/index.ts';
import type { Result } from '@/lib/result/index.ts';
import { limits } from './tree.ts';
import { flags, sourceFlags } from '@/lib/artifacts/index.ts';
type Slot = { worker: Worker; pending?: (result: Result<string>) => void; fault?: string };
type Operation = 'snapshot' | 'diff' | 'export' | 'verify' | 'store-hash';
function complete(slot: Slot, result: Result<string>): void {
  const pending = slot.pending; delete slot.pending; slot.worker.unref(); pending?.(result);
}
function result(message: unknown): Result<string> {
  if (isObject(message)) {
    if (message['ok'] === true && typeof message['value'] === 'string') return { ok: true, value: message['value'] };
    if (message['ok'] === false && isObject(message['error']) && typeof message['error']['code'] === 'string' && typeof message['error']['message'] === 'string') return failure(message['error']['code'], message['error']['message']);
  }
  return failure('io', 'The snapshot worker returned an invalid result.');
}
export class Workers {
  readonly #workers: Slot[] = [];
  readonly #entry: URL;
  constructor(entry = new URL('./worker.ts', import.meta.url)) { this.#entry = entry; }
  #create(): Slot {
    const slot: Slot = { worker: new Worker(this.#entry, {
      execArgv: process.execArgv.includes('--no-experimental-strip-types') ? flags() : sourceFlags(),
      resourceLimits: { maxOldGenerationSizeMb: limits.workerOldMiB, maxYoungGenerationSizeMb: limits.workerYoungMiB, stackSizeMb: limits.workerStackMiB }
    }) }; this.#workers.push(slot);
    slot.worker.on('message', (message: unknown) => { complete(slot, result(message)); });
    slot.worker.once('error', () => { slot.fault = 'The snapshot worker failed.'; });
    slot.worker.once('exit', () => { this.#workers.splice(this.#workers.indexOf(slot), 1); complete(slot, failure('io', slot.fault ?? 'The snapshot worker exited.')); });
    slot.worker.unref(); return slot;
  }
  perform(path: string, destination: string | undefined, operation: Operation): Promise<Result<string>> {
    try {
      const slot = this.#workers.find(slot => !slot.pending && !slot.fault) ?? (this.#workers.length < limits.workers ? this.#create() : undefined);
      if (!slot) return Promise.resolve(failure('budget', 'The snapshot worker pool is full.'));
      return new Promise(resolve => { slot.pending = resolve; slot.worker.ref(); slot.worker.postMessage({ path, destination, operation }); });
    } catch { return Promise.resolve(failure('io', 'The snapshot worker could not be started.')); }
  }
}
const pool = new Workers();
export const perform = (path: string, destination: string | undefined, operation: Operation): Promise<Result<string>> => pool.perform(path, destination, operation);
