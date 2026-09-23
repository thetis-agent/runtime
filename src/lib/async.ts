/** An unbounded async queue bridging push-style producers to AsyncIterable consumers. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;
  private failure: unknown;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close(error?: unknown): void {
    this.closed = true;
    this.failure = error;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift() as T, done: false });
        if (this.closed) {
          if (this.failure) return Promise.reject(this.failure);
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
