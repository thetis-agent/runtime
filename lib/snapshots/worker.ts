/** Verify copies before admitting their hashes to a generation; ADR 0012 §2, GN-002. */
import { parentPort } from 'node:worker_threads';
import { cp, rm, mkdir } from 'node:fs/promises';
import { hashTree } from './tree.ts';
import { failure, isObject } from '@/lib/result/index.ts';
import type { Result } from '@/lib/result/index.ts';
import { differences } from './differences.ts';
import { exportStore } from './export.ts';
import { verifyTree } from '@/lib/artifacts/verify-tree.ts';

async function run(input: unknown): Promise<Result<string>> {
  if (!isObject(input) || typeof input['path'] !== 'string') return failure('invalid-args', 'The snapshot worker requires a source path.');
  if (input['operation'] === 'verify') return verifyTree(input['path']);
  if (input['operation'] === 'export' && typeof input['destination'] === 'string') return exportStore(input['path'], input['destination']);
  if (input['operation'] === 'diff' && typeof input['destination'] === 'string') return differences(input['path'], input['destination']);
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

if (!parentPort) throw new Error('The snapshot worker requires its parent port.');
const port = parentPort; let active = false;
port.on('message', (input: unknown) => {
  if (active) { port.postMessage(failure('budget', 'The snapshot worker is already busy.')); return; }
  active = true;
  void run(input).then(result => { active = false; port.postMessage(result); }, () => { active = false; port.postMessage(failure('io', 'The snapshot worker failed.')); });
});
