/** Validate calculation inputs once at the worker edge; ADR 0006, ADR 0014. */
import { parentPort, workerData } from 'node:worker_threads';
import { Schemas } from '../schema/index.ts';
import { validators } from './index.ts';
import { gate } from './metrics.ts';
import { isObject, failure } from '../result/index.ts';
const input: unknown = workerData;
const checks = validators(new Schemas());
if (!parentPort) throw new Error('The calculation requires a worker port.');
parentPort.postMessage(isObject(input) && checks.plan(input['plan']) && checks.submission(input['submission']) ? gate(input['submission'], input['plan']) : failure('invalid-args', 'The evaluation calculation input does not match its schema.'));
parentPort.close();
