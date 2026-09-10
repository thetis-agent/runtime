/** Refuse links and special files at the final open while bounding growth during a read; ST-002–003. */
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { Result } from '@/contracts/storage/index.ts';
import { failure } from '@/lib/result/index.ts';

export async function read(path: string, maximum: number): Promise<Result<Uint8Array, 'io' | 'budget'>> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1) return failure('io', 'The storage entry is not a private regular file.');
      if (stat.size > maximum) return failure('budget', 'The stored value exceeds its byte limit.');
      const chunks: Uint8Array[] = []; let count = 0;
      for (;;) {
        const chunk = Buffer.alloc(Math.min(65536, maximum - count + 1));
        const { bytesRead } = await file.read(chunk);
        if (bytesRead === 0) return { ok: true, value: Buffer.concat(chunks, count) };
        count += bytesRead;
        if (count > maximum) return failure('budget', 'The stored value exceeds its byte limit.');
        chunks.push(chunk.subarray(0, bytesRead));
      }
    } finally { await file.close(); }
  } catch { return failure('io', 'The stored value could not be read.'); }
}
