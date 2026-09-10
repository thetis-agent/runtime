/** Extract only regular git blobs with bounded canonical paths; proposal §5, GN-002. */
import { mkdir, writeFile, chmod, lstat, readdir, rmdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { git, limits } from './git.ts';
import { paths } from '@/lib/snapshots/tree.ts';
import { failure } from '@/lib/result/index.ts';
import type { Result } from '@/lib/result/index.ts';

export function safe(path: string): boolean {
  return path.length <= 4096 && !path.includes('\\') && !path.includes('\0') && path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..' && part.toLowerCase() !== '.git' && part !== '.gitmodules');
}
export async function extract(repository: string, commit: string, destination: string): Promise<Result<void>> {
  const listing = await git(repository, ['ls-tree', '-rz', '--full-tree', commit]); if (!listing.ok) return listing;
  const entries = listing.value.toString('utf8').split('\0').filter(Boolean); let bytes = 0;
  if (entries.length > limits.entries) return failure('budget', 'The registry tree exceeds its entry limit.');
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/su.exec(entry);
    const mode = match?.[1]; const object = match?.[2]; const path = match?.[3];
    if (!mode || !object || !path || !safe(path)) return failure('outside-roots', 'The registry tree contains an unsupported path or entry.');
    const content = await git(repository, ['cat-file', 'blob', object]); if (!content.ok) return content;
    bytes += content.value.length;
    if (content.value.length > limits.fileBytes || bytes > limits.treeBytes) return failure('budget', 'The registry tree exceeds its byte limit.');
    await mkdir(dirname(join(destination, path)), { recursive: true, mode: 0o755 });
    await writeFile(join(destination, path), content.value, { flag: 'wx', mode: mode === '100755' ? 0o755 : 0o644 });
  }
  return { ok: true, value: undefined };
}
export async function normalize(directory: string): Promise<Result<string[]>> {
  const entries = await paths(directory); if (!entries.ok) return entries;
  const files: string[] = [];
  for (const path of entries.value.sort()) {
    if (!safe(path)) return failure('outside-roots', 'The package contains a reserved registry path.');
    const info = await lstat(join(directory, path));
    await chmod(join(directory, path), info.isDirectory() || (info.mode & 0o111) !== 0 ? 0o755 : 0o644);
    if (info.isFile()) files.push(path);
  }
  for (const path of entries.value.sort().reverse()) {
    const target = join(directory, path);
    if ((await lstat(target)).isDirectory() && (await readdir(target)).length === 0) await rmdir(target);
  }
  return { ok: true, value: files };
}
