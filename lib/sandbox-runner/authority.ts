/** Consume the inherited credential without giving ordinary children an environment token; ADR 0021, KS-001. */
import { createReadStream } from 'node:fs';
import { Socket } from 'node:net';
import { failure } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';

export async function authority(): Promise<Result<{ socket: Socket; token: string }, 'auth'>> {
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    const source: AsyncIterable<unknown> = createReadStream('', { fd: 4, autoClose: true });
    for await (const chunk of source) {
      if (!(chunk instanceof Uint8Array) || (bytes += chunk.length) > 256) return failure('auth', 'The inherited credential is invalid.');
      chunks.push(chunk);
    }
    if (!bytes) return failure('auth', 'The inherited credential is absent.');
    const token = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return { ok: true, value: { socket: new Socket({ fd: 3, readable: true, writable: true }), token } };
  } catch { return failure('auth', 'The inherited authority descriptors are unavailable.'); }
}
