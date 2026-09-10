/** Bound the RFC 6455 gateway edge before schema dispatch; ADR 0006, ADR 0009. */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';
import { failure } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';
export const limits = { messageBytes: 1048576, queueBytes: 1048576, pendingWrites: 64, pendingCalls: 8, maxFragments: 1024, maxBufferedChunks: 4096, headerBytes: 16384 };
export type RequestHandler = (request: IncomingMessage, response: ServerResponse) => Promise<Result<void>>;
export interface Handler { message(value: unknown): Promise<Result<void>>; close(): void }
export class Channel {
  readonly #socket: WebSocket;
  #bytes = 0; #writes = 0;
  constructor(socket: WebSocket) { this.#socket = socket; }
  write(frame: Record<string, unknown>): Promise<Result<void>> {
    if (this.#socket.readyState !== WebSocket.OPEN) return Promise.resolve(failure('io', 'The gateway connection is closed.'));
    const data = JSON.stringify(frame); const bytes = Buffer.byteLength(data);
    if (bytes > limits.messageBytes || this.#bytes + bytes > limits.queueBytes || this.#writes >= limits.pendingWrites) return Promise.resolve(failure('budget', 'The gateway output queue is full.'));
    this.#bytes += bytes; this.#writes++;
    return new Promise(resolve => {
      this.#socket.send(data, { binary: false, compress: false }, error => {
        this.#bytes -= bytes; this.#writes--; resolve(error ? failure('io', 'The gateway frame could not be delivered.') : { ok: true, value: undefined });
      });
    });
  }
}
function parsed(data: RawData, binary: boolean): Result<unknown> {
  if (binary) return failure('unsupported', 'The gateway requires JSON text frames.');
  try { return { ok: true, value: JSON.parse((Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)).toString('utf8')) }; }
  catch { return failure('invalid-args', 'The gateway frame is not valid JSON.'); }
}
function messages(socket: WebSocket, channel: Channel, handler: Handler): void {
  let pending = 0;
  const finish = async (result: Result<void>) => {
    if (!result.ok) { const sent = await channel.write({ type: 'error', ...result.error }); if (!sent.ok) socket.terminate(); }
  };
  socket.on('message', (data, binary) => {
    const decoded = parsed(data, binary);
    if (!decoded.ok) { void finish(decoded); return; }
    if (pending >= limits.pendingCalls) { socket.terminate(); return; }
    pending++;
    void handler.message(decoded.value).then(finish, () => finish(failure('io', 'The gateway command failed.'))).finally(() => { pending--; });
  });
}
export function accept(socket: Socket, admitted: () => void, factory: (channel: Channel) => Handler, request?: RequestHandler): Promise<Result<void>> {
  const result = Promise.withResolvers<Result<void>>(); let handler: Handler | undefined; let upgraded: WebSocket | undefined;
  const options = { noServer: true, clientTracking: false, perMessageDeflate: false, maxPayload: limits.messageBytes, maxFragments: limits.maxFragments, maxBufferedChunks: limits.maxBufferedChunks };
  const websocket = new WebSocketServer(options);
  const http = createServer({ maxHeaderSize: limits.headerBytes }, (incoming, response) => {
    if (!request) { response.writeHead(404); response.end(); return; }
    request(incoming, response).catch(() => { response.destroy(); });
  });
  http.maxRequestsPerSocket = 1; http.on('clientError', () => { socket.destroy(); });
  websocket.on('error', () => { socket.destroy(); });
  http.on('upgrade', (upgrading, connection, head) => {
    if (upgrading.url !== '/ws') { connection.destroy(); return; }
    websocket.handleUpgrade(upgrading, connection, head, stream => {
      upgraded = stream; const channel = new Channel(stream); handler = factory(channel);
      stream.on('error', () => { result.resolve(failure('protocol', 'The gateway WebSocket frame is invalid.')); socket.destroy(); });
      messages(stream, channel, handler); admitted();
    });
  });
  socket.once('error', () => { result.resolve(failure('io', 'The gateway connection failed.')); });
  socket.once('close', () => { handler?.close(); upgraded?.terminate(); result.resolve({ ok: true, value: undefined }); });
  http.emit('connection', socket); socket.resume(); return result.promise;
}
