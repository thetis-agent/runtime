/** Export only a stopped trusted store, then hash its explicit host-path relocation; GN-007. */
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { perform } from '@/lib/snapshots/pool.ts';
import { atomicWrite } from '@/lib/files/atomic.ts';
import { relocations, relocationLimits } from './relocation.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';

export async function exportDeployment(source: string, destination: string): Promise<Result<string>> {
  const mappings = await relocations(source); if (!mappings.ok) return mappings;
  if (mappings.value.length >= relocationLimits.entries) return failure('budget', 'The kernel store has reached its relocation limit.');
  const copied = await perform(source, destination, 'export'); if (!copied.ok) return copied;
  try {
    const root = await realpath(destination);
    const written = await atomicWrite(join(root, '.relocation.json'), Buffer.from(JSON.stringify([...mappings.value, { from: source, to: root }])));
    return written.ok ? await perform(root, undefined, 'store-hash') : written;
  } catch { return failure('io', 'The exported kernel store could not be bound to its new root.'); }
}
