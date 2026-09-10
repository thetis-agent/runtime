/** Keep socket framing bounded and backpressured; PR-002, KS-021. */
import { Socket } from 'node:net';
import { encode, frames } from './index.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';

async function* bytes(socket: Socket): AsyncGenerator<Uint8Array> {
  const incoming: AsyncIterable<unknown> = socket.iterator({ destroyOnReturn: false });
  for await (const chunk of incoming) {
    if (!(chunk instanceof Uint8Array)) throw new Error('A binary socket yielded a non-binary chunk.');
    yield chunk;
  }
}

export const socketFrames = (socket: Socket) => frames(bytes(socket));
export function connect(path: string): Promise<Result<Socket, 'provider'>> {
  return new Promise(resolve => {
    const socket = new Socket();
    socket.on('error', () => { resolve(failure('provider', 'The service socket could not be reached.')); });
    socket.once('connect', () => { resolve({ ok: true, value: socket }); });
    socket.connect(path);
  });
}

export async function send(socket: Socket, frame: unknown): Promise<Result<void, 'provider'>> {
  const encoded = encode(frame);
  if (!encoded.ok) return failure('provider', encoded.error.message);
  return new Promise(resolve => {
    socket.write(encoded.value, error => { resolve(error ? failure('provider', 'The service socket write failed.') : { ok: true, value: undefined }); });
  });
}
