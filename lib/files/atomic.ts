/** Commit private metadata by synced replacement without exposing partial values; ADR 0009, ADR 0012. */
import { open, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';

export async function atomicWrite(path: string, bytes: Uint8Array): Promise<Result<void, 'io'>> {
  const temporary = join(dirname(path), `${randomBytes(16).toString('hex')}.pending`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    return await syncDirectory(dirname(path));
  } catch {
    try { await rm(temporary, { force: true }); }
    catch { return failure('io', 'The incomplete private write could not be removed.'); }
    return failure('io', 'The private write could not be committed.');
  }
}

export async function syncDirectory(path: string): Promise<Result<void, 'io'>> {
  try {
    const directory = await open(path, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return { ok: true, value: undefined };
  } catch { return failure('io', 'The directory could not be synced.'); }
}
