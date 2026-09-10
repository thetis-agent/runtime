/** Copy activated system-service code into a private root-owned tree before publication; implementation note 0052. */
import { chmod, lstat, readdir, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { snapshot } from '@/lib/snapshots/index.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import type { Install } from './install.ts';

const limits = { entries: 20000, depth: 64 };
async function protectedTree(path: string, budget: { entries: number }, depth: number): Promise<Result<void>> {
  if (--budget.entries < 0 || depth > limits.depth) return failure('budget', 'The release ownership walk exceeds its entry or depth limit.');
  const info = await lstat(path);
  if (!info.isDirectory() && !info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) return failure('outside-roots', 'Activated release entries must be ordinary root-owned files and directories without group or public write access.');
  if (info.isDirectory()) for (const name of await readdir(path)) { const child = await protectedTree(join(path, name), budget, depth + 1); if (!child.ok) return child; }
  return { ok: true, value: undefined };
}

export async function adopt(install: Install, release: string): Promise<Result<void>> {
  if (install.service !== 'system') return { ok: true, value: undefined };
  if (process.getuid?.() !== 0) return failure('forbidden', 'Applying a system-service release requires the host operator: run sudo thetis update --apply.');
  const pending = join(install.prefix, `.adopt-${randomUUID()}`); const previous = join(install.prefix, `.staged-${randomUUID()}`);
  try {
    if (await realpath(release) !== release) return failure('outside-roots', 'The activated release path is not canonical.');
    // The service can still change its staging tree. Copying and checking it avoids following a raced chown outside that tree.
    const copied = await snapshot(release, pending); if (!copied.ok) return copied;
    const protected_ = await protectedTree(pending, { entries: limits.entries }, 0); if (!protected_.ok) return protected_;
    await chmod(pending, 0o755); await chmod(join(pending, '.release'), 0o755);
    for (const name of await readdir(join(pending, '.release'))) await chmod(join(pending, '.release', name), 0o644);
    await chmod(join(pending, 'kernel-pins.json'), 0o644);
    await rename(release, previous);
    try { await rename(pending, release); } catch { await rename(previous, release); return failure('io', 'The protected release could not be published.'); }
    await rm(previous, { recursive: true });
    return { ok: true, value: undefined };
  } catch { return failure('io', 'The release could not be made immutable to the service account.'); }
  finally { await rm(pending, { recursive: true, force: true }); }
}
