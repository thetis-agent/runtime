/** Provide bounded deterministic clocks at external edges; TE-015, ADR 0016 §4. */
export interface Clock {
  now(): number;
  wait(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export const clock: Clock = {
  now: () => performance.now(),
  wait: (milliseconds, signal) => new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const finish = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', finish, { once: true });
  })
};

export class ManualClock implements Clock {
  #time = 0;
  readonly #waiters = new Set<{ at: number; finish: () => void }>();
  now(): number { return this.#time; }
  wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (this.#waiters.size >= 1024) throw new Error('The test clock waiter limit was exceeded.');
    return new Promise(resolve => {
      const finish = (): void => { this.#waiters.delete(waiter); signal?.removeEventListener('abort', finish); resolve(); };
      const waiter = { at: this.#time + milliseconds, finish };
      if (signal?.aborted) { resolve(); return; }
      signal?.addEventListener('abort', finish, { once: true });
      this.#waiters.add(waiter);
    });
  }
  advance(milliseconds: number): void {
    this.#time += milliseconds;
    for (const waiter of this.#waiters) if (waiter.at <= this.#time) waiter.finish();
  }
}
