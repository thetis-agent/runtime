/** Retain the frozen member manifest by its verified tree hash; GN-002, GN-005. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SnapshotStore } from '@/lib/snapshots/store.ts';
import { atomicWrite } from '@/lib/files/atomic.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
export async function manifestSnapshot(root: string, manifest: Record<string, unknown>): Promise<Result<string>> {
  const bytes = Buffer.from(JSON.stringify(manifest)); if (bytes.length > 1048576) return failure('budget', 'The default snapshot manifest exceeds its byte limit.');
  await mkdir(root, { recursive: true, mode: 0o700 }); const staging = await mkdtemp(join(root, 'pending-'));
  try {
    const written = await atomicWrite(join(staging, 'manifest.json'), bytes); if (!written.ok) return written;
    return await new SnapshotStore(join(root, 'snapshots')).capture(staging);
  } catch { return failure('io', 'The default snapshot manifest could not be retained.'); }
  finally { await rm(staging, { recursive: true, force: true }); }
}
