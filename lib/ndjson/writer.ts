/** Prioritize control frames before queued bulk and bound every pending write; KS-018. */
import type { Socket } from 'node:net';
import { encode, PriorityFrames } from './index.ts';
import { failure } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';

export class FrameWriter {
  readonly #socket: Socket;
  readonly #queue = new PriorityFrames();
  readonly #pending = new Map<Buffer, (result: Result<void>) => void>();
  #running = false;
  #failed = false;
  #task: Promise<void> = Promise.resolve();
  constructor(socket: Socket) { this.#socket = socket; socket.on('error', () => { this.close(); }); }

  write(frame: unknown, control = false): Promise<Result<void>> {
    if (this.#failed) return Promise.resolve(failure('io', 'The socket writer is closed.'));
    const encoded = encode(frame); if (!encoded.ok) return Promise.resolve(encoded);
    const queued = this.#queue.push(encoded.value, control); if (!queued.ok) return Promise.resolve(queued);
    const completed = new Promise<Result<void>>(resolve => { this.#pending.set(encoded.value, resolve); });
    if (!this.#running) { this.#running = true; this.#task = Promise.resolve().then(() => this.#flush()); }
    return completed;
  }

  async #flush(): Promise<void> {
    try {
      for (let frame = this.#queue.next(); frame !== undefined; frame = this.#queue.next()) {
        const written = await new Promise<Result<void>>(resolve => {
          this.#socket.write(frame, error => { resolve(error ? failure('io', 'The socket write failed.') : { ok: true, value: undefined }); });
        });
        this.#pending.get(frame)?.(written); this.#pending.delete(frame);
        if (!written.ok) { this.close(); break; }
      }
    } catch { this.close(); }
    finally { this.#running = false; }
  }

  close(): void {
    this.#failed = true;
    for (const resolve of this.#pending.values()) resolve(failure('io', 'The socket writer closed before delivery.'));
    this.#pending.clear();
    while (this.#queue.next() !== undefined) { /* Release bounded bulk reservations after transport failure. */ }
  }

  settled(): Promise<void> { return this.#task; }
}
