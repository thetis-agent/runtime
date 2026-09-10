/** Repoint only socket inodes within a canonical target root; GN-004, ADR 0025. */
import { mkdir, realpath, lstat, rename, open } from 'node:fs/promises';
import { dirname, basename, join, relative, isAbsolute } from 'node:path';
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';

export const endpointLimits = { pathBytes: 107 };

export class Endpoint {
  readonly root: string;
  readonly path: string;
  private constructor(root: string) { this.root = root; this.path = join(root, 'public', 'current.sock'); }

  static async open(root: string): Promise<Result<Endpoint, 'io'>> {
    try {
      await mkdir(join(root, 'public'), { recursive: true, mode: 0o700 }); const canonical = await realpath(root);
      if (Buffer.byteLength(join(canonical, 'public', 'current.sock')) > endpointLimits.pathBytes) return failure('io', 'The generation endpoint exceeds the Linux socket path limit.');
      return { ok: true, value: new Endpoint(canonical) };
    }
    catch { return failure('io', 'The generation endpoint root could not be opened.'); }
  }

  async repoint(source: string): Promise<Result<void, 'io' | 'outside-roots'>> {
    try {
      const parent = await realpath(dirname(source)); const path = join(parent, basename(source)); const within = relative(this.root, path);
      if (!within || within === '..' || within.startsWith('../') || isAbsolute(within) || path === this.path) return failure('outside-roots', `${source} is not a private socket under the generation endpoint root.`);
      if (!(await lstat(path)).isSocket()) return failure('outside-roots', `${source} exists but is not a generation socket.`);
      const existing = await lstat(this.path).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (existing && !existing.isSocket()) return failure('outside-roots', `${this.path} exists but is not a generation socket.`);
      await rename(path, this.path);
      const directory = await open(dirname(this.path), 'r'); try { await directory.sync(); } finally { await directory.close(); }
      return { ok: true, value: undefined };
    } catch { return failure('io', 'The generation socket could not be atomically repointed.'); }
  }
}
