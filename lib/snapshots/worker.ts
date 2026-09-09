/** Verify copies before admitting their hashes to a generation; ADR 0012 §2, GN-002. */
import { parentPort, workerData } from 'node:worker_threads';
import { cp, rm, mkdir } from 'node:fs/promises';
import { hashTree } from './tree.ts';
import { failure, isObject } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';

async function run(input: unknown): Promise<Result<string>> {
  if (!isObject(input) || typeof input['path'] !== 'string') return failure('invalid-args', 'The snapshot worker requires a source path.');
  const initial = await hashTree(input['path']); if (!initial.ok) return initial;
  if (input['destination'] === undefined) return initial;
  if (typeof input['destination'] !== 'string') return failure('invalid-args', 'The snapshot destination must be a path.');
  try { await mkdir(input['destination'], { mode: 0o700 }); }
  catch { return failure('io', 'The snapshot destination already exists or cannot be created.'); }
  try {
    await cp(input['path'], input['destination'], { recursive: true, errorOnExist: false, force: false, preserveTimestamps: true });
    const copied = await hashTree(input['destination']);
    if (copied.ok && copied.value === initial.value) return copied;
    await rm(input['destination'], { recursive: true, force: true });
    return failure('io', 'The copied snapshot does not match the stopped source.');
  } catch {
    try { await rm(input['destination'], { recursive: true, force: true }); }
    catch { return failure('io', 'The failed snapshot copy could not be removed.'); }
    return failure('io', 'The snapshot copy could not be completed.');
  }
}

parentPort?.postMessage(await run(workerData));
