/** Persist reservations before vendor access so restart cannot reset spend; ADR 0020, PR-010. */
import { readFile, lstat } from 'node:fs/promises';
import type { Schemas, Result } from '../schema/index.ts';
import { failure, isObject } from '../schema/index.ts';
import { atomicWrite } from '../files/atomic.ts';
import { readBounded } from '../files/read-bounded.ts';
import type { Checkpoint, Window } from './types.ts';

export const limits = { bytes: 4 * 1024 * 1024, queued: 64 };
export class BudgetCheckpoint {
  readonly initial: readonly Window[];
  readonly #path: string;
  #queued = 0;
  #tail: Promise<unknown> = Promise.resolve();
  #failed = false;
  private constructor(path: string, windows: readonly Window[]) { this.#path = path; this.initial = structuredClone(windows); }

  static async open(path: string, schemas: Schemas): Promise<Result<BudgetCheckpoint>> {
    const schema: unknown = JSON.parse(await readFile(new URL('./schema.json', import.meta.url), 'utf8'));
    if (!isObject(schema)) throw new Error('The committed budget schema is invalid.');
    const check = schemas.compile<Checkpoint>(schema);
    const present = await exists(path); if (!present.ok) return present;
    if (!present.value) {
      const saved = await atomicWrite(path, Buffer.from('{"version":1,"windows":[]}'));
      return saved.ok ? { ok: true, value: new BudgetCheckpoint(path, []) } : saved;
    }
    const bytes = await readBounded(path, limits.bytes); if (!bytes.ok) return bytes;
    try {
      const value: unknown = JSON.parse(bytes.value.toString('utf8'));
      if (!check(value) || new Set(value.windows.map(window => window.person)).size !== value.windows.length) return failure('invalid-args', 'The persisted budget checkpoint is invalid.');
      return { ok: true, value: new BudgetCheckpoint(path, value.windows) };
    } catch { return failure('invalid-args', 'The persisted budget checkpoint is invalid.'); }
  }

  save(windows: Window[]): Promise<Result<void>> {
    if (this.#failed) return Promise.resolve(failure('io', 'The budget checkpoint writer has failed.'));
    const bytes = Buffer.from(JSON.stringify({ version: 1, windows }));
    if (bytes.length > limits.bytes || this.#queued >= limits.queued) return Promise.resolve(failure('budget', 'The budget checkpoint exceeds its storage or queue limit.'));
    this.#queued++;
    const written = this.#tail.then(async () => {
      if (this.#failed) return failure('io', 'The budget checkpoint writer has failed.');
      const result = await atomicWrite(this.#path, bytes); if (!result.ok) this.#failed = true; return result;
    });
    this.#tail = written;
    return written.finally(() => { this.#queued--; });
  }
}

async function exists(path: string): Promise<Result<boolean>> {
  try { const entry = await lstat(path); return entry.isFile() ? { ok: true, value: true } : failure('io', 'The budget checkpoint is not a regular file.'); }
  catch (error) { return error instanceof Error && 'code' in error && error.code === 'ENOENT' ? { ok: true, value: false } : failure('io', 'The budget checkpoint could not be inspected.'); }
}
