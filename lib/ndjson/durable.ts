/** Serialize bounded byte reservations and refuse writes after durability failure; ADR 0032. */
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { syncDirectory } from '../files/atomic.ts';
import type { AppendLimits, AppendLog } from '../../contracts/storage/index.ts';
import { failure } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';

export type Limits = AppendLimits;
export class Durable implements AppendLog {
  readonly #file: FileHandle; readonly #limits: Limits;
  #bytes: number; #queued = 0; #reserved = 0; #failed = false;
  #tail: Promise<unknown> = Promise.resolve();
  #closing: Promise<void> | undefined;
  private constructor(file: FileHandle, bytes: number, limits: Limits) { this.#file = file; this.#bytes = bytes; this.#limits = { ...limits }; }
  static async open(path: string, limits: Limits): Promise<Result<Durable, 'io'>> {
    limits = { ...limits };
    if (!Number.isSafeInteger(limits.rowBytes) || limits.rowBytes < 1 || limits.rowBytes > 16777216 || !Number.isSafeInteger(limits.queuedRows) || limits.queuedRows < 1 || limits.queuedRows > 4096) return failure('io', 'The append log limits are invalid.');
    let file: FileHandle | undefined;
    try {
      if (await realpath(dirname(path)) !== resolve(dirname(path))) return failure('io', 'The append log directory is not canonical.');
      file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1) { await file.close(); return failure('io', 'The append log is not a private regular file.'); }
      const synced = await syncDirectory(dirname(path));
      if (!synced.ok) { await file.close(); return synced; }
      return { ok: true, value: new Durable(file, stat.size, limits) };
    } catch {
      try { await file?.close(); } catch { return failure('io', 'The failed append log could not be closed.'); }
      return failure('io', 'The turn log could not be opened.');
    }
  }
  async append(bytes: Uint8Array, maximum: number): Promise<Result<void, 'io' | 'budget'>> {
    if (this.#closing || this.#failed) return failure('io', 'The turn log writer is closed or has failed.');
    if (this.#queued >= this.#limits.queuedRows) return failure('budget', 'The turn log queue is full.');
    if (!Number.isSafeInteger(maximum) || maximum < 0 || bytes.length > this.#limits.rowBytes || this.#bytes + this.#reserved + bytes.length > maximum) return failure('budget', 'The turn log pool is full.');
    const value = Uint8Array.from(bytes);
    this.#queued++; this.#reserved += value.length;
    const pending = this.#tail.then(() => this.#write(value)); this.#tail = pending;
    try { return await pending; } finally { this.#queued--; this.#reserved -= value.length; }
  }
  async #write(bytes: Uint8Array): Promise<Result<void, 'io'>> {
    if (this.#failed) return failure('io', 'The turn log writer has failed.');
    try { await this.#file.writeFile(bytes); this.#bytes += bytes.length; await this.#file.sync(); return { ok: true, value: undefined }; }
    catch { this.#failed = true; return failure('io', 'The turn log row could not be committed.'); }
  }
  close(): Promise<void> { this.#closing ??= this.#tail.then(() => this.#file.close()); return this.#closing; }
}
