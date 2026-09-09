/** Separate trusted observations from submitted claims in a bounded append-only journal; ADR 0014, KS-020. */
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { failure } from '../../lib/schema/index.ts';
import type { Result } from '../../lib/schema/index.ts';

export type Provenance = 'kernel-observed' | 'candidate-reported' | 'reviewed-reported';
export interface Observed { provenance: 'kernel-observed'; at: number; target: string; kind: string; data: Readonly<Record<string, unknown>> }
export const limits = { bytes: 64 * 1024 * 1024, recoveryBytes: 1024 * 1024, rowBytes: 65536, queuedRows: 256 };
export class Journal {
  readonly #file: FileHandle;
  readonly #now: () => number;
  #bytes: number;
  readonly #limits: typeof limits;
  #queued = 0;
  #reserved = 0;
  #failed = false;
  #tail: Promise<unknown> = Promise.resolve();
  private constructor(file: FileHandle, bytes: number, now: () => number, settings: typeof limits) { this.#file = file; this.#bytes = bytes; this.#now = now; this.#limits = settings; }

  static async open(path: string, now: () => number, settings = limits): Promise<Result<Journal, 'io'>> {
    try { const file = await open(path, 'a', 0o600); return { ok: true, value: new Journal(file, (await file.stat()).size, now, settings) }; }
    catch { return failure('io', 'The turn log could not be opened.'); }
  }

  observed(target: string, kind: string, data: Readonly<Record<string, unknown>>, recovery = false): Promise<Result<void, 'io' | 'budget'>> {
    return this.#append('kernel-observed', target, kind, data, recovery);
  }

  reported(target: string, kind: string, data: Readonly<Record<string, unknown>>, reviewed = false): Promise<Result<void, 'io' | 'budget'>> {
    return this.#append(reviewed ? 'reviewed-reported' : 'candidate-reported', target, kind, data, false);
  }

  async #append(provenance: Provenance, target: string, kind: string, data: Readonly<Record<string, unknown>>, recovery: boolean): Promise<Result<void, 'io' | 'budget'>> {
    if (this.#queued >= this.#limits.queuedRows) return failure('budget', 'The turn log queue is full.');
    const bytes = Buffer.from(`${JSON.stringify({ provenance, at: this.#now(), target, kind, data })}\n`);
    const maximum = this.#limits.bytes - (recovery ? 0 : this.#limits.recoveryBytes);
    if (bytes.length > this.#limits.rowBytes || this.#bytes + this.#reserved + bytes.length > maximum) return failure('budget', 'The turn log pool is full.');
    this.#queued++; this.#reserved += bytes.length;
    const pending = this.#tail.then(() => this.#write(bytes));
    this.#tail = pending;
    try { return await pending; }
    finally { this.#queued--; this.#reserved -= bytes.length; }
  }

  async #write(bytes: Uint8Array): Promise<Result<void, 'io'>> {
    if (this.#failed) return failure('io', 'The turn log writer has failed.');
    try { await this.#file.writeFile(bytes); this.#bytes += bytes.length; await this.#file.sync(); return { ok: true, value: undefined }; }
    catch { this.#failed = true; return failure('io', 'The turn log row could not be committed.'); }
  }

  async close(): Promise<void> { await this.#tail; await this.#file.close(); }
}
