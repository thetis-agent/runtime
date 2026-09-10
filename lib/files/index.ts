/** Resolve symlinks before checking the granted roots and their modes; TE-019, ADR 0005. */
import { realpath, stat, lstat } from 'node:fs/promises';
import { dirname, basename, resolve, relative, isAbsolute } from 'node:path';
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';

export interface Root { path: string; mode: 'ro' | 'rw'; space: string }
async function canonicalTarget(path: string): Promise<{ path: string; exists: boolean } | undefined> {
  let current = path;
  const suffix: string[] = [];
  for (let depth = 0; depth < 256; depth++) {
    try {
      await lstat(current);
      return { path: resolve(await realpath(current), ...suffix), exists: suffix.length === 0 };
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') return undefined;
      try { if ((await lstat(current)).isSymbolicLink()) return undefined; }
      catch (missing) { if (!(missing instanceof Error) || !('code' in missing) || missing.code !== 'ENOENT') return undefined; }
      const parent = dirname(current);
      if (parent === current) return undefined;
      suffix.unshift(basename(current)); current = parent;
    }
  }
  return undefined;
}

export async function resolvePath(path: string, roots: readonly Root[], write = false): Promise<Result<string, 'outside-roots' | 'not-found'>> {
  const available = roots.map(root => `${root.space} ${root.mode}`).join(', ');
  const outside = () => failure('outside-roots', `${path} is outside the spaces you can reach (${available}).`);
  if (!path.trim() || path.includes('\0') || /^[a-zA-Z]:/u.test(path)) return outside();
  const base = roots.find(root => root.mode === 'rw')?.path ?? roots[0]?.path;
  if (!base) return outside();
  const requested = resolve(base, path);
  const canonical = await canonicalTarget(requested);
  if (!canonical) return outside();
  try {
    const matches: { root: Root; length: number }[] = [];
    for (const root of roots) {
      const resolved = await realpath(root.path);
      const child = relative(resolved, canonical.path);
      if (child === '' || child !== '..' && !child.startsWith('../') && !isAbsolute(child)) matches.push({ root, length: resolved.length });
    }
    const deepest = matches.sort((a, b) => b.length - a.length || Number(a.root.mode === 'rw') - Number(b.root.mode === 'rw'))[0];
    if (!deepest || write && deepest.root.mode === 'ro') return outside();
    if (!write && !canonical.exists) return failure('not-found', `${path} does not exist in the spaces you can reach (${available}).`);
    return { ok: true, value: canonical.path };
  } catch { return outside(); }
}

export async function boundedFile(path: string, bytes: number): Promise<Result<void, 'budget' | 'io'>> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size <= bytes ? { ok: true, value: undefined } : failure('budget', `${path} exceeds the file budget or is not a regular file.`);
  } catch { return failure('io', `${path} could not be inspected.`); }
}
