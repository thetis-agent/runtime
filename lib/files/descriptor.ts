/** Consume a bounded inherited secret before any unprivileged process starts; ADR 0009, KS-001. */
import { createReadStream } from 'node:fs';
import { failure } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';
export async function descriptor(fd: number, bytes: number): Promise<Result<Buffer>> {
  if (!Number.isSafeInteger(fd) || fd < 3 || fd > 1024 || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 65536) return failure('invalid-args', 'The inherited secret descriptor is invalid.');
  const output = Buffer.alloc(bytes); let offset = 0;
  try {
    const source = createReadStream('', { fd, autoClose: true, highWaterMark: bytes + 1 });
    for await (const chunk of source) {
      const value: unknown = chunk; if (!Buffer.isBuffer(value) || offset + value.length > bytes) { output.fill(0); return failure('invalid-args', 'The inherited secret has an invalid byte length.'); }
      value.copy(output, offset); offset += value.length;
    }
    if (offset !== bytes) { output.fill(0); return failure('invalid-args', 'The inherited secret has an invalid byte length.'); }
    return { ok: true, value: output };
  } catch { output.fill(0); return failure('io', 'The inherited secret descriptor could not be read.'); }
}
