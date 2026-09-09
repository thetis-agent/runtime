/** Bound asynchronous handoffs without buffering an entire stream; PR-002, KS-018. */
import { failure } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';

export const queueLimits = { entries: 8192, bytes: 4 * 1024 * 1024 };
export class Queue<T> implements AsyncIterable<T> {
  readonly #items: { value: T; bytes: number }[] = [];
  readonly #limits: typeof queueLimits;
  #bytes = 0;
  #closed = false;
  #waiting: ((item: IteratorResult<T>) => void) | undefined;
  constructor(limits = queueLimits) { this.#limits = limits; }

  push(value: T, bytes: number): Result<void, 'budget'> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Queue weights must be nonnegative byte counts.');
    if (this.#closed || this.#items.length >= this.#limits.entries || this.#bytes + bytes > this.#limits.bytes) return failure('budget', 'The stream queue is closed or full.');
    if (this.#waiting) { const deliver = this.#waiting; this.#waiting = undefined; deliver({ done: false, value }); }
    else { this.#items.push({ value, bytes }); this.#bytes += bytes; }
    return { ok: true, value: undefined };
  }

  close(): void {
    this.#closed = true;
    if (this.#waiting) { const deliver = this.#waiting; this.#waiting = undefined; deliver({ done: true, value: undefined }); }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => {
      const item = this.#items.shift();
      if (item) { this.#bytes -= item.bytes; return Promise.resolve({ done: false, value: item.value }); }
      if (this.#closed) return Promise.resolve({ done: true, value: undefined });
      if (this.#waiting) throw new Error('A stream queue has exactly one consumer.');
      return new Promise<IteratorResult<T>>(resolve => { this.#waiting = resolve; });
    } };
  }
}
