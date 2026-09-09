/** Bound final-consumer file reads even if the file grows after inspection; SK-003, KS-008. */
import { fileChunks } from '../ndjson/file.ts';
import { failure } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';

export async function readBounded(path: string, maximum: number): Promise<Result<Buffer, 'budget' | 'io'>> {
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for await (const chunk of fileChunks(path)) {
      bytes += chunk.length;
      if (bytes > maximum) return failure('budget', 'The file exceeds its byte budget.');
      chunks.push(chunk);
    }
    return { ok: true, value: Buffer.concat(chunks, bytes) };
  } catch { return failure('io', 'The file could not be read.'); }
}
