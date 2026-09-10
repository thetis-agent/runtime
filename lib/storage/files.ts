/** Bound byte pools and acknowledge only durable replacements in an owned root; ADR 0040, ST-001–005. */
import { mkdir, realpath, opendir, lstat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import type { Limits, Result, Storage } from '@/contracts/storage/index.ts';
import { failure } from '@/lib/result/index.ts';
import { atomicWrite, syncDirectory } from '@/lib/files/atomic.ts';
import { read } from './read.ts';

const validKey = (key: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(key);
function validLimits(limits: Limits): boolean {
  return Number.isSafeInteger(limits.entries) && limits.entries > 0 && limits.entries <= 10000
    && Number.isSafeInteger(limits.valueBytes) && limits.valueBytes > 0 && limits.valueBytes <= 16777216
    && Number.isSafeInteger(limits.bytes) && limits.bytes > 0 && limits.bytes <= 1073741824;
}
async function inventory(root: string, limits: Limits): Promise<Result<Map<string, number>, 'io' | 'budget'>> {
  const entries = new Map<string, number>(); let bytes = 0;
  for await (const entry of await opendir(root)) {
    if (entries.size >= limits.entries) return failure('budget', 'The storage entry pool is full.');
    if (!entry.isFile() || !validKey(entry.name)) return failure('io', 'The storage root contains an invalid entry.');
    const stat = await lstat(join(root, entry.name));
    if (!stat.isFile() || stat.nlink !== 1) return failure('io', 'The storage entry is not a private regular file.');
    bytes += stat.size;
    if (stat.size > limits.valueBytes || bytes > limits.bytes) return failure('budget', 'The storage byte pool is full.');
    entries.set(entry.name, stat.size);
  }
  return { ok: true, value: entries };
}

export class Files implements Storage {
  readonly #root: string; readonly #limits: Limits; readonly #entries: Map<string, number>;
  readonly #identity: { dev: number; ino: number };
  #bytes: number; #busy = false; #failed = false;
  private constructor(root: string, limits: Limits, entries: Map<string, number>, identity: { dev: number; ino: number }) {
    this.#root = root; this.#limits = { ...limits }; this.#entries = entries;
    this.#identity = identity;
    this.#bytes = [...entries.values()].reduce((total, size) => total + size, 0);
  }
  static async open(root: string, limits: Limits): Promise<Result<Files, 'invalid-args' | 'budget' | 'io'>> {
    limits = { ...limits };
    if (!validLimits(limits)) return failure('invalid-args', 'The storage limits are invalid.');
    try {
      const parent = dirname(resolve(root));
      if (await realpath(parent) !== parent) return failure('io', 'The storage parent is not canonical.');
      try { await mkdir(root, { mode: 0o700 }); }
      catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error; }
      const canonical = await realpath(root);
      const stat = await lstat(root);
      if (canonical !== resolve(root) || !stat.isDirectory()) return failure('io', 'The storage root is not canonical.');
      const synced = await syncDirectory(dirname(canonical)); if (!synced.ok) return synced;
      const entries = await inventory(canonical, limits);
      return entries.ok ? { ok: true, value: new Files(canonical, limits, entries.value, { dev: stat.dev, ino: stat.ino }) } : entries;
    } catch { return failure('io', 'The storage root could not be opened.'); }
  }
  has(key: string): boolean { return validKey(key) && this.#entries.has(key); }
  async get(key: string): Promise<Result<Uint8Array>> {
    if (!validKey(key)) return failure('invalid-args', 'The storage key is invalid.');
    if (this.#failed) return failure('io', 'The storage writer has failed; reopen the store.');
    if (!this.has(key)) return failure('not-found', 'The storage key does not exist.');
    if (this.#busy) return failure('budget', 'The storage operation pool is full.');
    this.#busy = true;
    try {
      const path = await this.#path(key); if (!path.ok) return path;
      return await read(path.value, this.#limits.valueBytes);
    } finally { this.#busy = false; }
  }
  async put(key: string, value: Uint8Array): Promise<Result<void, 'invalid-args' | 'budget' | 'io'>> {
    if (!validKey(key)) return failure('invalid-args', 'The storage key is invalid.');
    if (this.#failed) return failure('io', 'The storage writer has failed; reopen the store.');
    const previous = this.#entries.get(key);
    if (this.#busy || previous === undefined && this.#entries.size >= this.#limits.entries) return failure('budget', 'The storage writer or entry pool is full.');
    if (value.byteLength > this.#limits.valueBytes || this.#bytes - (previous ?? 0) + value.byteLength > this.#limits.bytes) return failure('budget', 'The storage byte pool is full.');
    const bytes = Uint8Array.from(value); this.#busy = true;
    try {
      const path = await this.#path(key); if (!path.ok) return path;
      const written = await atomicWrite(path.value, bytes);
      if (written.ok) { this.#bytes += bytes.length - (previous ?? 0); this.#entries.set(key, bytes.length); }
      else this.#failed = true;
      return written;
    } finally { this.#busy = false; }
  }
  async #path(key: string): Promise<Result<string, 'io'>> {
    try {
      const stat = await lstat(this.#root);
      if (await realpath(this.#root) !== this.#root || !stat.isDirectory() || stat.dev !== this.#identity.dev || stat.ino !== this.#identity.ino) return failure('io', 'The storage root changed.');
      const path = join(this.#root, key);
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.nlink !== 1) return failure('io', 'The storage entry is not a private regular file.');
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
      return { ok: true, value: path };
    } catch { return failure('io', 'The storage path could not be inspected.'); }
  }
}
