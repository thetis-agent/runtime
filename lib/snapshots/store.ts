/** Retain verified state by digest without overwriting an earlier snapshot; GN-002, GN-006. */
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { snapshot, changes } from './index.ts';
import { failure } from '../result/index.ts';
import type { Result } from '../result/index.ts';

export const limits = { snapshots: 1024 };
export class SnapshotStore {
  readonly #root: string;
  #busy = false;
  constructor(root: string) { this.#root = root; }

  async capture(source: string): Promise<Result<string>> {
    if (this.#busy) return failure('budget', 'The snapshot store already has an active writer.');
    this.#busy = true; const pending = join(this.#root, `.pending-${randomUUID()}`);
    try {
      const result = await this.#capture(source, pending);
      try { await rm(pending, { recursive: true, force: true }); } catch { return failure('io', 'The snapshot staging directory could not be removed.'); }
      return result;
    } finally { this.#busy = false; }
  }

  async #capture(source: string, pending: string): Promise<Result<string>> {
    try {
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      if ((await readdir(this.#root)).length >= limits.snapshots) return failure('budget', 'The retained snapshot pool is full.');
      const copied = await snapshot(source, pending); if (!copied.ok) return copied;
      const path = join(this.#root, copied.value.slice(7));
      try { await rename(pending, path); }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') return failure('io', 'The state snapshot could not be retained.');
        const existing = await snapshot(path);
        if (!existing.ok || existing.value !== copied.value) return failure('io', 'The retained state snapshot does not match its digest.');
      }
      return copied;
    } catch { return failure('io', 'The state snapshot could not be retained.'); }
  }

  async restore(hash: string, destination: string): Promise<Result<void>> {
    if (!/^sha256:[a-f0-9]{64}$/u.test(hash)) return failure('invalid-args', 'The state snapshot digest is invalid.');
    const path = join(this.#root, hash.slice(7));
    const verified = await snapshot(path); if (!verified.ok) return verified;
    if (verified.value !== hash) return failure('io', 'The retained state snapshot no longer matches its digest.');
    const copied = await snapshot(path, destination); if (!copied.ok) return copied;
    return copied.value === hash ? { ok: true, value: undefined } : failure('io', 'The restored state does not match its snapshot.');
  }

  async changed(before: string, after: string): Promise<Result<string[]>> {
    for (const hash of [before, after]) {
      if (!/^sha256:[a-f0-9]{64}$/u.test(hash)) return failure('invalid-args', 'The state snapshot digest is invalid.');
      const verified = await snapshot(join(this.#root, hash.slice(7))); if (!verified.ok) return verified;
      if (verified.value !== hash) return failure('io', 'The retained state snapshot no longer matches its digest.');
    }
    return changes(join(this.#root, before.slice(7)), join(this.#root, after.slice(7)));
  }
}
