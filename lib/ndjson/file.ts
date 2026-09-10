/** Read append-only records without buffering their whole file; ADR 0013, TE-009. */
import { open } from 'node:fs/promises';
import { frames } from './index.ts';
import { failure } from '../result/index.ts';
import type { Result } from '../result/index.ts';

export const fileLimits = { bytes: 67108864, rows: 100000, frameBytes: 65536 };

export async function* fileChunks(path: string, chunkBytes = 65536): AsyncGenerator<Uint8Array> {
  const file = await open(path, 'r');
  try {
    for (;;) {
      const bytes = Buffer.alloc(chunkBytes);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, null);
      if (bytesRead === 0) return;
      yield bytes.subarray(0, bytesRead);
    }
  } finally { await file.close(); }
}

export async function* fileFrames(path: string, limits = fileLimits): AsyncGenerator<Result<unknown>> {
  let rows = 0; const scan = { bytes: 0, exhausted: false };
  const bounded = { async *[Symbol.asyncIterator]() {
    for await (const chunk of fileChunks(path)) {
      scan.bytes += chunk.length;
      if (scan.bytes > limits.bytes) { scan.exhausted = true; return; }
      yield chunk;
    }
  } };
  try {
    for await (const frame of frames(bounded, limits.frameBytes)) {
      if (scan.exhausted) break;
      if (++rows > limits.rows) { yield failure('budget', 'The journal exceeds its row limit.'); return; }
      yield frame; if (!frame.ok) return;
    }
    if (scan.exhausted) yield failure('budget', 'The journal exceeds its byte limit.');
  } catch { yield failure('io', 'The journal could not be read.'); }
}
