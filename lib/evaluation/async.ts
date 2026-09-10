/** Bound scoring arithmetic off the kernel event loop without moving act authority; ADR 0014 §3. */
import { Worker } from 'node:worker_threads';
import type { Plan, Submission } from './types.ts';
import type { Gate } from './metrics.ts';
import { failure, isObject } from '../result/index.ts';
import type { Result } from '../result/index.ts';
import { Schemas } from '../schema/index.ts';
import { encode } from '../ndjson/index.ts';
import schema from '../../contracts/evaluator/schema.json' with { type: 'json' };

export const calculationLimits = { workers: 2, inputBytes: 1048576 };
let workers = 0;
const schemas = new Schemas(); schemas.compile(schema);
const check = schemas.compile<Gate>({ $ref: `${schema.$id}#/$defs/gate` });

export async function calculate(submission: Submission, plan: Plan): Promise<Result<Gate>> {
  if (workers >= calculationLimits.workers) return failure('budget', 'The evaluation calculation pool is exhausted.');
  const input = encode({ submission, plan }, calculationLimits.inputBytes); if (!input.ok) return input;
  workers++; let worker: Worker | undefined;
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { workerData: { submission, plan } });
    const running = worker;
    return await new Promise(resolve => {
      running.once('message', (value: unknown) => {
        if (isObject(value) && value['ok'] === true && check(value['value'])) resolve({ ok: true, value: value['value'] });
        else if (isObject(value) && value['ok'] === false && isObject(value['error']) && value['error']['code'] === 'invalid-args' && typeof value['error']['message'] === 'string') resolve(failure('invalid-args', value['error']['message']));
        else resolve(failure('io', 'The evaluation calculation returned an invalid result.'));
      });
      running.once('error', () => { resolve(failure('io', 'The evaluation calculation failed.')); });
      running.once('exit', () => { resolve(failure('io', 'The evaluation calculation exited without a result.')); });
    });
  } catch { return failure('io', 'The evaluation calculation could not start.'); }
  finally { if (worker) await worker.terminate(); workers--; }
}
