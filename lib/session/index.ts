/** Keep bounded, person-local replay outside the kernel's control channel; ADR 0019, KS-004. */
import type { Envelope } from '../../contracts/turn-events/types.ts';
import type { Clock } from '../events/index.ts';
import { failure } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';
import { Batches } from './batch.ts';
import type { Item, Send } from './batch.ts';
import type { Subscribed } from './types.ts';

export const settings = { conversations: 32, subscribers: 64, historyBytes: 1048576 };
type History = { cursor: number; bytes: number; rows: Item[]; subscribers: Set<Batches> };

export class SessionEvents {
  readonly #clock: Clock;
  readonly #histories = new Map<string, History>();
  #subscribers = 0;
  constructor(clock: Clock) { this.#clock = clock; }

  observe(event: Envelope): void {
    if (!['token', 'output', 'end'].includes(event.type)) return;
    const history = this.#histories.get(event.conversation); if (!history) return;
    const bytes = Buffer.byteLength(JSON.stringify(event));
    const item = { cursor: ++history.cursor, event, bytes };
    for (const subscriber of history.subscribers) subscriber.push(item);
    while (history.rows.length && history.bytes + bytes > settings.historyBytes) { const removed = history.rows.shift(); if (removed) history.bytes -= removed.bytes; }
    if (bytes <= settings.historyBytes) { history.rows.push(item); history.bytes += bytes; }
  }

  subscribe(conversation: string, from: number | undefined, send: Send, fail: (result: Result<void>) => void): Result<{ result: Subscribed; close(): void }> {
    if (this.#subscribers >= settings.subscribers) return failure('budget', 'The session subscriber pool is full.');
    let history = this.#histories.get(conversation);
    if (!history) {
      if (this.#histories.size >= settings.conversations) {
        const idle = [...this.#histories].find(([, value]) => !value.subscribers.size);
        if (!idle) return failure('budget', 'The session replay pool is full.');
        this.#histories.delete(idle[0]);
      }
      history = { cursor: 0, bytes: 0, rows: [], subscribers: new Set() }; this.#histories.set(conversation, history);
    }
    const oldest = history.rows[0]?.cursor ?? history.cursor + 1;
    if (from !== undefined && (from < oldest - 1 || from > history.cursor)) return failure('not-found', 'The requested conversation events are no longer retained.');
    let closed = false; const current = history;
    const close = (): void => { if (closed) return; closed = true; batches.close(); current.subscribers.delete(batches); this.#subscribers--; };
    const batches = new Batches(this.#clock, send, result => { close(); fail(result); });
    this.#subscribers++; history.subscribers.add(batches);
    if (from !== undefined) for (const item of history.rows) if (item.cursor > from) batches.push(item);
    return { ok: true, value: { result: { conversation, cursor: history.cursor, oldest }, close } };
  }
}
