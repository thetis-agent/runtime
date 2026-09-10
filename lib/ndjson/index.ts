/** Bound frames before parsing and retain unknown fields; KS-021, TE-031. */
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';

export const defaults = { frameBytes: 1024 * 1024, queueFrames: 256, queueBytes: 16 * 1024 * 1024, controlFrames: 4, controlBytes: 65536 };

export async function* frames(
  source: AsyncIterable<Uint8Array>, frameBytes = defaults.frameBytes
): AsyncGenerator<Result<unknown, 'frame-too-large' | 'invalid-args'>> {
  let pending = Buffer.alloc(0);
  for await (const chunk of source) {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const end = chunk.indexOf(10, offset);
      const stop = end === -1 ? chunk.byteLength : end;
      if (pending.length + stop - offset > frameBytes) {
        yield failure('frame-too-large', `The socket frame exceeds ${String(frameBytes)} bytes.`);
        return;
      }
      pending = Buffer.concat([pending, chunk.subarray(offset, stop)]);
      offset = stop + 1;
      if (end !== -1) {
        yield parse(pending);
        pending = Buffer.alloc(0);
      }
    }
  }
  if (pending.length > 0) yield failure('invalid-args', 'The socket closed with an incomplete frame.');
}

function parse(bytes: Buffer): Result<unknown, 'invalid-args'> {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return failure('invalid-args', 'The socket frame is not valid UTF-8 JSON.');
  }
}

export function encode(value: unknown, frameBytes = defaults.frameBytes): Result<Buffer, 'frame-too-large' | 'invalid-args'> {
  try {
    if (value === undefined) return failure('invalid-args', 'The socket frame is not JSON.');
    const json = JSON.stringify(value);
    const bytes = Buffer.from(`${json}\n`);
    return bytes.length - 1 <= frameBytes ? { ok: true, value: bytes }
      : failure('frame-too-large', `The socket frame exceeds ${String(frameBytes)} bytes.`);
  } catch {
    return failure('invalid-args', 'The socket frame is not JSON.');
  }
}

export class PriorityFrames {
  readonly #control: Buffer[] = [];
  readonly #bulk: Buffer[] = [];
  #bytes = 0;
  readonly limits: typeof defaults;
  constructor(limits = defaults) { this.limits = limits; }

  push(frame: Buffer, control: boolean): Result<void, 'budget'> {
    if (this.#bytes + frame.length > this.limits.queueBytes - (control ? 0 : this.limits.controlBytes) || this.#control.length + this.#bulk.length >= this.limits.queueFrames - (control ? 0 : this.limits.controlFrames)) {
      return failure('budget', 'The socket queue is full.');
    }
    (control ? this.#control : this.#bulk).push(frame);
    this.#bytes += frame.length;
    return { ok: true, value: undefined };
  }

  next(): Buffer | undefined {
    const frame = this.#control.shift() ?? this.#bulk.shift();
    if (frame) this.#bytes -= frame.length;
    return frame;
  }
}
