/** Stage work edits once and serialize generation requests without starting processes; GN-001, ADR 0012. */
import { mkdir, realpath, readdir, mkdtemp, rm } from 'node:fs/promises';
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { SnapshotStore } from '@/lib/snapshots/store.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import type { Clock } from '@/lib/events/index.ts';
import { limits } from './index.ts';
import { compile } from '@/lib/artifacts/index.ts';
export interface Work { name: string; source: string; hash: string }
export interface Settings { debounceMs: number; pending: number; artifacts?: boolean; previous?(name: string): string | undefined }
export class WorkQueue {
  readonly #root: string; readonly #cache: string; readonly #clock: Clock; readonly #settings: Settings;
  readonly #ready: (changes: readonly Work[], elapsedMs: number) => Promise<Result<void>>;
  readonly #store: SnapshotStore; readonly #dirty = new Set<string>();
  #running: Promise<Result<void>> | undefined; #fault: Result<void> | undefined;
  #changedAt = 0;
  #timer: AbortController | undefined; #closed = false; #watcher: FSWatcher | undefined;
  constructor(root: string, cache: string, clock: Clock, ready: (changes: readonly Work[], elapsedMs: number) => Promise<Result<void>>, settings: Settings = limits) {
    if (!Number.isSafeInteger(settings.debounceMs) || settings.debounceMs < 0 || !Number.isSafeInteger(settings.pending) || settings.pending < 1) throw new Error('The work queue settings are invalid.');
    this.#root = root; this.#cache = cache; this.#clock = clock; this.#ready = ready; this.#settings = { ...settings }; this.#store = new SnapshotStore(cache);
  }
  notify(name: string): Result<void> {
    if (this.#closed) return failure('io', 'The work queue is closed.');
    if (!/^[a-z][a-z0-9-]{0,127}$/u.test(name)) return failure('invalid-args', 'The work package name is invalid.');
    if (!this.#dirty.has(name) && this.#dirty.size >= this.#settings.pending) return failure('budget', 'The work change queue is full.');
    this.#dirty.add(name); this.#changedAt = this.#clock.now(); this.#fault = undefined;
    this.#start();
    return { ok: true, value: undefined };
  }
  #start(): void {
    this.#running ??= this.#drive().finally(() => {
      this.#running = undefined;
      if (this.#dirty.size && !this.#closed) this.#start();
    });
  }
  async #drive(): Promise<Result<void>> {
    try {
      while (this.#dirty.size && !this.#closed) {
        this.#timer = new AbortController(); await this.#clock.wait(Math.max(0, this.#settings.debounceMs - (this.#clock.now() - this.#changedAt)), this.#timer.signal);
        if (this.#timer.signal.aborted) break;
        if (this.#clock.now() - this.#changedAt < this.#settings.debounceMs) continue;
        const began = this.#changedAt; const names = [...this.#dirty].sort(); this.#dirty.clear(); const staged: Work[] = [];
        for (const name of names) { const result = await this.#stage(name); if (!result.ok) { this.#fault = result; return result; } staged.push(result.value); }
        const accepted = await this.#ready(staged, this.#clock.now() - began); if (!accepted.ok) { this.#fault = accepted; return accepted; }
      }
      return { ok: true, value: undefined };
    } catch { this.#fault = failure('io', 'The work change could not be staged or applied.'); return this.#fault; }
    finally { this.#timer = undefined; }
  }
  async #stage(name: string): Promise<Result<Work>> {
    const root = await realpath(this.#root); const source = await realpath(join(root, name));
    if (source !== join(root, name)) return failure('outside-roots', 'The work package is not a canonical directory inside work.');
    await mkdir(this.#cache, { recursive: true, mode: 0o700 }); const cache = await realpath(this.#cache);
    if (cache === root || cache.startsWith(`${root}/`)) return failure('outside-roots', 'The staged cache is inside the watched work directory.');
    const captured = await this.#store.capture(source); if (!captured.ok) return captured;
    if (this.#settings.artifacts) {
      const temporary = await mkdtemp(join(cache, '.artifacts-'));
      try {
        const destination = join(temporary, 'package');
        const compiled = await compile(join(cache, captured.value.slice(7)), destination, this.#settings.previous?.(name)); if (!compiled.ok) return compiled;
        const verified = await this.#store.capture(destination); if (!verified.ok) return verified;
        return { ok: true, value: { name, source: join(cache, verified.value.slice(7)), hash: verified.value } };
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }
    return { ok: true, value: { name, source: join(cache, captured.value.slice(7)), hash: captured.value } };
  }
  async watch(): Promise<Result<void>> {
    if (this.#watcher || this.#closed) return failure('conflict', 'The work directory already has a watcher or is closed.');
    try {
      await mkdir(this.#root, { recursive: true, mode: 0o700 }); const root = await realpath(this.#root);
      if ((await readdir(root)).length > limits.workEntries) return failure('budget', 'The work directory exceeds its package limit.');
      this.#watcher = watch(root, { recursive: true }, (_event, path) => {
        const name = path?.toString().split('/')[0];
        if (!name) { this.#fault = failure('io', 'The work watcher did not identify the changed package.'); return; }
        const queued = this.notify(name); if (!queued.ok) this.#fault = queued;
      });
      this.#watcher.on('error', () => { this.#fault = failure('io', 'The work directory watcher failed.'); });
      return { ok: true, value: undefined };
    } catch { return failure('io', 'The work directory could not be watched.'); }
  }
  settled(): Promise<Result<void>> { return this.#running ?? Promise.resolve(this.#fault ?? { ok: true, value: undefined }); }
  get pending(): number { return this.#dirty.size; }
  async close(): Promise<Result<void>> {
    this.#closed = true; this.#watcher?.close(); this.#timer?.abort();
    return await this.#running ?? this.#fault ?? { ok: true, value: undefined };
  }
}
