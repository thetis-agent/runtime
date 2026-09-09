/** Route turns only through locally persisted conversation identities; KS-004, TE-009. */
import { stat } from 'node:fs/promises';
import type { SessionCreateParams } from '../../contracts/kernel-socket/types.ts';
import type { Input, Message } from '../../contracts/turn-events/types.ts';
import type { Stage } from '../../lib/events/stages.ts';
import { frozen } from '../../lib/events/stages.ts';
import type { Clock } from '../../lib/events/index.ts';
import type { Schemas, Result } from '../../lib/schema/index.ts';
import { failure } from '../../lib/schema/index.ts';
import type { Provider } from '../../lib/provider/index.ts';
import { Loop } from './index.ts';
import type { Options } from './index.ts';
import { Conversation } from './conversation.ts';
import { SessionStore } from './session-store.ts';
import type { SessionInfo } from './types.ts';

export const sessionLimits = { loaded: 8, fileBytes: 1024 * 1024, inputBytes: 65536, writes: 32, reads: 8 };
export interface Runtime { stages: readonly Stage[]; schemas: Schemas; clock: Clock; provider: Provider; options: Omit<Options, 'conversation' | 'refresh'>; report?: (params: Record<string, unknown>) => Promise<Result<void>> }
type Entry = { history: Conversation; loop: Loop };
type Slot = { users: number; loading: Promise<Result<Entry>> };
type Lease = { loading: Promise<Result<Entry>>; release(): void };

export class Sessions {
  readonly #store: SessionStore;
  readonly #runtime: Runtime;
  readonly #slots = new Map<string, Slot>();
  readonly #active = new Map<string, AbortController>();
  readonly #writes = new Set<Promise<unknown>>();
  #paused = false;
  #reading = 0;
  private constructor(store: SessionStore, runtime: Runtime) {
    this.#store = store; const { model, provider, token, space, system, roots, mode } = runtime.options;
    this.#runtime = { ...runtime, stages: [...runtime.stages], options: frozen({ model, provider, token, space, system, roots, mode }) };
  }

  static async open(root: string, runtime: Runtime): Promise<Result<Sessions>> {
    const store = await SessionStore.open(root, runtime.schemas);
    return store.ok ? { ok: true, value: new Sessions(store.value, runtime) } : store;
  }
  list(): Promise<Result<SessionInfo[]>> { return this.#read(() => this.#store.list()); }
  create(input: SessionCreateParams): Promise<Result<SessionInfo>> {
    return this.#write(() => this.#store.create(input));
  }
  get active(): number { return this.#active.size; }

  history(id: string): Promise<Result<Message[]>> { return this.#read(() => this.#history(id)); }
  async #history(id: string): Promise<Result<Message[]>> {
    const lease = this.#lease(id); if (!lease.ok) return lease;
    try {
      const entry = await lease.value.loading;
      return entry.ok ? { ok: true, value: entry.value.history.project().history } : entry;
    } finally { lease.value.release(); }
  }

  submit(id: string, input: Input): Promise<Result<{ conversation: string; head: string | null }>> {
    return this.#write(() => this.#submit(id, input));
  }

  async #submit(id: string, input: Input): Promise<Result<{ conversation: string; head: string | null }>> {
    if (this.#paused) return failure('switching', 'The environment is quiescing.');
    if (Buffer.byteLength(JSON.stringify(input)) > sessionLimits.inputBytes) return failure('budget', 'The input exceeds the conversation byte limit.');
    const lease = this.#lease(id); if (!lease.ok) return lease;
    try {
      const loaded = await lease.value.loading; if (!loaded.ok) return loaded;
      if (this.#quiescing()) return failure('switching', 'The environment is quiescing.');
      if (this.#active.has(id)) return failure('budget', 'The conversation already has an active turn.');
      const cancel = new AbortController(); this.#active.set(id, cancel);
      try {
        const result = await loaded.value.loop.turn(input, { ...this.#runtime.options, conversation: id }, cancel.signal);
        const report = loaded.value.loop.report;
        if (!report) throw new Error('A completed turn has no diagnostic report.');
        const sent = await this.#runtime.report?.(report.ok ? report.value : { conversation: id, reportError: report.error });
        if (sent && !sent.ok) return sent;
        if (!report.ok) return report;
        return result.ok ? { ok: true, value: { conversation: id, head: loaded.value.history.head } } : result;
      } finally { this.#active.delete(id); }
    } finally { lease.value.release(); }
  }

  cancel(id: string): Result<{ cancelled: boolean }> {
    const active = this.#active.get(id); active?.abort();
    return { ok: true, value: { cancelled: active !== undefined } };
  }

  async pause(): Promise<void> { this.#paused = true; await Promise.all([...this.#writes]); }
  resume(): void { this.#paused = false; }
  #quiescing(): boolean { return this.#paused; }

  #write<T>(start: () => Promise<Result<T>>): Promise<Result<T>> {
    if (this.#paused) return Promise.resolve(failure('switching', 'The environment is quiescing.'));
    if (this.#writes.size >= sessionLimits.writes) return Promise.resolve(failure('budget', 'The conversation write queue is full.'));
    const work = start();
    const tracked = work.finally(() => { this.#writes.delete(tracked); }); this.#writes.add(tracked);
    return tracked;
  }

  async #read<T>(start: () => Promise<Result<T>>): Promise<Result<T>> {
    if (this.#reading >= sessionLimits.reads) return failure('budget', 'The conversation read queue is full.');
    this.#reading++;
    try { return await start(); } finally { this.#reading--; }
  }

  #lease(id: string): Result<Lease> {
    let slot = this.#slots.get(id);
    if (!slot) {
      if (this.#slots.size >= sessionLimits.loaded) return failure('budget', 'The active conversation pool is full.');
      slot = { users: 0, loading: this.#load(id) }; this.#slots.set(id, slot);
    }
    slot.users++; const held = slot;
    return { ok: true, value: { loading: held.loading, release: () => {
      held.users--; if (!held.users) this.#slots.delete(id);
    } } };
  }

  async #load(id: string): Promise<Result<Entry>> {
    const info = await this.#store.info(id); if (!info.ok) return info;
    const path = await this.#store.path(id, 'conversation.jsonl', true); if (!path.ok) return path;
    try {
      const existing = await stat(path.value).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (existing && (!existing.isFile() || existing.size > sessionLimits.fileBytes)) return failure('budget', 'The conversation exceeds its loading byte limit.');
      const history = new Conversation(path.value, this.#runtime.schemas); const loaded = await history.load(); if (!loaded.ok) return loaded;
      const { stages, schemas, clock, provider } = this.#runtime;
      const entry = { history, loop: new Loop(stages, schemas, clock, provider, history) };
      return { ok: true, value: entry };
    } catch { return failure('io', 'The conversation could not be opened.'); }
  }
}
