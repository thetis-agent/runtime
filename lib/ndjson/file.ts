/** Read append-only records without buffering their whole file; ADR 0013, TE-009. */
import { open } from 'node:fs/promises';

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
