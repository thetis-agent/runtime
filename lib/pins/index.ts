/** Preserve live conversation releases through restart and serialize prune against new leases; KS-011. */
import { mkdir, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWrite } from '../files/atomic.ts';
import { readBounded } from '../files/read-bounded.ts';
import { failure, isObject } from '../schema/index.ts';
import type { Schemas, Result } from '../schema/index.ts';
import schema from './schema.json' with { type: 'json' };
import type { Lease, State } from './types.ts';

export const pinLimits = { bytes: 1048576, conversations: 4096, hashes: 256, queued: 128 };
export class Pins {
  readonly #path: string; readonly #schemas: Schemas;
  #leases: State | undefined;
  #failed = false; #queued = 0;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(path: string, schemas: Schemas) { this.#path = path; this.#schemas = schemas; }

  create(target: string, hashes: readonly string[], operation: () => Promise<Result<unknown>>): Promise<Result<unknown>> {
    return this.#serial(async () => {
      const loaded = await this.#load(); if (!loaded.ok) return loaded;
      if (loaded.value.length >= pinLimits.conversations) return failure('budget', 'The conversation pin ledger is full.');
      const created = await operation(); if (!created.ok) return created;
      if (!isObject(created.value) || typeof created.value['id'] !== 'string') return failure('invalid-args', 'The environment returned no conversation identity.');
      const pinned = await this.#pin({ target, conversation: created.value['id'], hashes: [...hashes] });
      return pinned.ok ? created : pinned;
    });
  }

  pin(lease: Lease): Promise<Result<void>> { return this.#serial(() => this.#pin(lease)); }

  prune<T>(hash: string, operation: () => Promise<Result<T>>): Promise<Result<T>> {
    return this.#serial(async () => {
      const loaded = await this.#load(); if (!loaded.ok) return loaded;
      const held = loaded.value.find(lease => lease.hashes.includes(hash));
      return held ? failure('conflict', `The release is pinned by live conversation ${held.conversation}.`) : operation();
    });
  }

  async #pin(lease: Lease): Promise<Result<void>> {
    const loaded = await this.#load(); if (!loaded.ok) return loaded;
    const leases = structuredClone(loaded.value); const existing = leases.find(row => row.target === lease.target && row.conversation === lease.conversation);
    if (existing) existing.hashes = [...new Set([...existing.hashes, ...lease.hashes])].sort();
    else leases.push({ ...structuredClone(lease), hashes: [...new Set(lease.hashes)].sort() });
    const bytes = Buffer.from(`${JSON.stringify(leases)}\n`);
    if (!this.#schemas.compile<State>(schema)(leases) || bytes.length > pinLimits.bytes) { this.#failed = true; return failure('budget', 'The conversation pin ledger exceeds its limits.'); }
    const saved = await atomicWrite(this.#path, bytes);
    if (!saved.ok) { this.#failed = true; return saved; }
    this.#leases = leases; return { ok: true, value: undefined };
  }

  async #load(): Promise<Result<State>> {
    if (this.#failed) return failure('io', 'The conversation pin ledger is unavailable; pruning is refused.');
    if (this.#leases) return { ok: true, value: this.#leases };
    try {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      let exists = true;
      try { if (!(await lstat(this.#path)).isFile()) return failure('outside-roots', 'The conversation pin ledger is not a plain file.'); }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') exists = false; else throw error; }
      if (!exists) { this.#leases = []; return { ok: true, value: [] }; }
      const bytes = await readBounded(this.#path, pinLimits.bytes); if (!bytes.ok) return bytes;
      const value: unknown = JSON.parse(bytes.value.toString('utf8'));
      if (!this.#schemas.compile<State>(schema)(value)) return failure('invalid-args', 'The conversation pin ledger violates its schema.');
      this.#leases = value; return { ok: true, value };
    } catch { this.#failed = true; return failure('io', 'The conversation pin ledger could not be read.'); }
  }

  async #serial<T>(operation: () => Promise<Result<T>>): Promise<Result<T>> {
    if (this.#queued >= pinLimits.queued) return failure('budget', 'The conversation pin queue is full.');
    this.#queued++;
    const pending = this.#tail.then(async () => {
      try { return await operation(); }
      catch { this.#failed = true; return failure('io', 'The conversation pin operation failed.'); }
    });
    this.#tail = pending;
    try { return await pending; } finally { this.#queued--; }
  }
}
