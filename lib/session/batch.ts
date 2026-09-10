/** Batch observer events without blocking turns on a slow surface; ADR 0015 §9, KS-020. */
import type { Envelope } from '../../contracts/turn-events/types.ts';
import type { Clock } from '../events/index.ts';
import { failure } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';

export const limits = { batchMs: 50, batchBytes: 4096, batchEvents: 256, queueBytes: 1048576, queueEvents: 8192, eventBytes: 786432 };
export type Item = { cursor: number; event: Envelope; bytes: number };
export type Send = (params: Record<string, unknown>) => Promise<Result<void>>;

export class Batches {
  readonly #clock: Clock;
  readonly #send: Send;
  readonly #fail: (result: Result<void>) => void;
  readonly #queue: Item[] = [];
  #bytes = 0;
  #closed = false;
  #writing = false;
  #due = false;
  #timer: AbortController | undefined;
  constructor(clock: Clock, send: Send, fail: (result: Result<void>) => void) { this.#clock = clock; this.#send = send; this.#fail = fail; }

  push(item: Item): void {
    if (this.#closed) return;
    if (item.bytes > limits.eventBytes || this.#bytes + item.bytes > limits.queueBytes || this.#queue.length >= limits.queueEvents) { this.close(); this.#fail(failure('budget', 'The session subscriber exceeds its event or queue byte limit.')); return; }
    this.#queue.push(item); this.#bytes += item.bytes;
    if (item.event.type === 'end') this.#due = true;
    this.#ready();
  }

  #ready(): void {
    if (this.#due || this.#bytes >= limits.batchBytes || this.#queue.length >= limits.batchEvents) this.#flush();
    else if (!this.#timer) {
      const timer = new AbortController(); this.#timer = timer;
      void this.#clock.wait(limits.batchMs, timer.signal).then(() => { if (!timer.signal.aborted) { this.#timer = undefined; this.#due = true; this.#flush(); } });
    }
  }

  #flush(): void {
    if (this.#writing || this.#closed || !this.#queue.length) return;
    this.#timer?.abort(); this.#timer = undefined; this.#writing = true; this.#due = false;
    const batch: Item[] = []; let bytes = 0;
    while (this.#queue.length && batch.length < limits.batchEvents && (bytes < limits.batchBytes || !batch.length)) {
      const item = this.#queue.shift(); if (!item) throw new Error('The session batch queue lost its item.');
      batch.push(item); bytes += item.bytes; this.#bytes -= item.bytes;
    }
    const last = batch.at(-1); if (!last) throw new Error('The session batch lost its cursor.');
    void this.#send({ type: 'session.events', conversation: last.event.conversation, cursor: last.cursor, events: batch.map(item => item.event) }).then(result => {
      this.#writing = false;
      if (!result.ok) { this.close(); this.#fail(result); return; }
      if (this.#queue.length) { if (this.#queue.some(item => item.event.type === 'end')) this.#due = true; this.#ready(); }
    }, () => { this.#writing = false; this.close(); this.#fail(failure('io', 'The session subscriber could not receive its batch.')); });
  }

  close(): void { this.#closed = true; this.#timer?.abort(); this.#timer = undefined; this.#queue.length = 0; this.#bytes = 0; }
}
