/** Present credentials separately and forward response frames without collecting the stream; PR-002–003. */
import type { Socket } from 'node:net';
import type { Provider, Description } from './index.ts';
import { connect, send, socketFrames } from '@/lib/ndjson/socket.ts';
import type { Schemas, Result } from '@/lib/schema/index.ts';
import { failure } from '@/lib/schema/index.ts';
import type { DescribeResponse, RequestEvent, ResponseEvent } from '@/contracts/provider/types.ts';

async function writeRequest(socket: Socket, request: AsyncIterable<RequestEvent>, signal: AbortSignal, state: { id: string }, cancel: () => void): Promise<Result<void>> {
  try {
    for await (const event of request) {
      if (event.type === 'begin') state.id = event.id;
      const written = await send(socket, event); if (!written.ok) return written;
      if (signal.aborted) { cancel(); break; }
    }
    return { ok: true, value: undefined };
  } catch { return failure('provider', 'The provider request stream failed.'); }
}

export class ProviderClient implements Provider {
  readonly #path: string;
  readonly #schemas: Schemas;
  readonly #token: string;
  constructor(path: string, schemas: Schemas, token: string) { this.#path = path; this.#schemas = schemas; this.#token = token; }

  async describe(): Promise<Description> {
    const opened = await connect(this.#path); if (!opened.ok) return opened;
    try {
      if (!(await send(opened.value, { v: '1', runToken: this.#token })).ok || !(await send(opened.value, { v: '1', method: 'describe' })).ok) return failure('provider', 'The provider capabilities could not be read.');
      for await (const frame of socketFrames(opened.value)) {
        if (!frame.ok || !this.#schemas.validator<DescribeResponse>('provider', 'describeResponse')(frame.value)) return failure('provider', 'The provider capabilities could not be read.');
        return { ok: true, value: frame.value };
      }
      return failure('provider', 'The provider capabilities could not be read.');
    } catch { return failure('provider', 'The provider capabilities socket closed.'); }
    finally { opened.value.destroy(); }
  }

  async *run(request: AsyncIterable<RequestEvent>, token: string, signal: AbortSignal): AsyncGenerator<ResponseEvent> {
    const opened = await connect(this.#path);
    if (!opened.ok) { yield { type: 'error', ...opened.error }; return; }
    const socket = opened.value;
    let writing: Promise<Result<void>> | undefined;
    let cancellation: Promise<Result<void>> | undefined;
    const state = { id: '' };
    const cancel = () => { if (state.id) cancellation ??= send(socket, { type: 'cancel', id: state.id }); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const hello = await send(socket, { v: '1', runToken: token });
      if (!hello.ok) { yield { type: 'error', ...hello.error }; return; }
      writing = writeRequest(socket, request, signal, state, cancel).then(result => { if (!result.ok) socket.destroy(); return result; });
      for await (const frame of socketFrames(socket)) {
        if (!frame.ok || !this.#schemas.validator<ResponseEvent>('provider', 'responseEvent')(frame.value)) { yield { type: 'error', code: 'provider', message: 'The provider response violates its schema.' }; return; }
        yield frame.value;
        if (frame.value.type === 'stop' || frame.value.type === 'error') return;
      }
      const sent = await writing;
      if (!sent.ok) yield { type: 'error', code: 'provider', message: sent.error.message };
      else yield { type: 'error', code: 'provider', message: 'The provider response ended without a stop or error.' };
    } catch { yield { type: 'error', code: 'provider', message: 'The provider response socket closed.' }; }
    finally { signal.removeEventListener('abort', cancel); socket.destroy(); if (writing) await writing; if (cancellation) await cancellation; }
  }
}
