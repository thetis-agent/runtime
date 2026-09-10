/** Negotiate methods and fence asynchronous RPC behind bounded frames; KS-001–003, KS-017–021. */
import type { Socket } from 'node:net';
import type { Validator as ValidateFunction } from '@/lib/schema/index.ts';
import type { Clock } from '@/lib/events/index.ts';
import type { Schemas, Result } from '@/lib/schema/index.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import { socketFrames } from '@/lib/ndjson/socket.ts';
import { FrameWriter } from '@/lib/ndjson/writer.ts';
import type { ConnectClient, ConnectKernel, Frame, Request, Response, Note, Method } from '@/contracts/kernel-socket/types.ts';
import { response, note } from './guards.ts';

export const limits = { capabilities: 128, pending: 128, handlers: 32, controlReserve: 4, timeoutMs: 10000, incomingBytes: 4 * 1024 * 1024, windowMs: 1000 };
export type Handler = (params: Record<string, unknown>) => Promise<Result<unknown>>;
export interface Callbacks { handlers: ReadonlyMap<Method, Handler>; note(value: Note): Promise<Result<void>> }
type Pending = { finish(result: Result<unknown>): void; timer: AbortController };
const control = (method: Method): boolean => method === 'health.probe' || method === 'session.cancel';

export class Peer {
  readonly #socket: Socket;
  readonly #clock: Clock;
  readonly #writer: FrameWriter;
  readonly #frames: ReturnType<typeof socketFrames>;
  readonly #check: ValidateFunction<Frame>;
  readonly #schemas: Schemas;
  readonly #callbacks: Callbacks;
  readonly #capabilities: readonly string[];
  readonly #common = new Set<string>();
  readonly #pending = new Map<string, Pending>();
  readonly #handlers = new Set<Promise<Result<void>>>();
  #id = 0;
  #closed = false;
  #reading: Promise<Result<void>> | undefined;
  #fault: Result<void> | undefined;
  supports(capability: string): boolean { return this.#common.has(capability); }
  constructor(socket: Socket, schemas: Schemas, clock: Clock, capabilities: readonly string[], callbacks: Callbacks) {
    this.#socket = socket; this.#schemas = schemas; this.#clock = clock; this.#callbacks = callbacks;
    this.#capabilities = [...capabilities]; this.#writer = new FrameWriter(socket); this.#frames = socketFrames(socket); this.#check = schemas.frame<Frame>();
  }

  async connect(): Promise<Result<ConnectKernel>> {
    const sent = await this.#writer.write({ v: '1', capabilities: this.#capabilities }, true); if (!sent.ok) return sent;
    const hello = await this.#hello<ConnectKernel>('connectKernel');
    if (hello.ok) this.#begin(hello.value.capabilities); else this.close();
    return hello;
  }

  async accept(identity: Pick<ConnectKernel, 'person' | 'scope' | 'generation' | 'project'>): Promise<Result<void>> {
    const hello = await this.#hello<ConnectClient>('connectClient');
    if (!hello.ok) { await this.#writer.write({ id: 'connect', error: hello.error }, true); this.close(); return hello; }
    const sent = await this.#writer.write({ ...identity, v: '1', capabilities: this.#capabilities }, true); if (!sent.ok) return sent;
    this.#begin(hello.value.capabilities); return { ok: true, value: undefined };
  }

  async #hello<T extends ConnectClient | ConnectKernel>(definition: string): Promise<Result<T>> {
    const controller = new AbortController();
    try {
      const first = await Promise.race([this.#frames.next(), this.#clock.wait(limits.timeoutMs, controller.signal).then(() => undefined)]);
      if (!first) return failure('deadline', 'The socket handshake exceeded its probe budget.');
      if (first.done || !first.value.ok || !this.#schemas.validator<T>('kernel-socket', definition)(first.value.value)) return failure('unsupported', 'The peer does not support socket major 1.');
      if (first.value.value.capabilities.length > limits.capabilities) return failure('budget', 'The capability list exceeds its limit.');
      return { ok: true, value: first.value.value };
    } catch { return failure('io', 'The socket closed during negotiation.'); }
    finally { controller.abort(); }
  }

  #begin(capabilities: readonly string[]): void {
    for (const value of capabilities) if (this.#capabilities.includes(value)) this.#common.add(value);
    this.#reading = this.#read();
  }

  async call(method: Method, params: Record<string, unknown>, timeoutMs = limits.timeoutMs): Promise<Result<unknown>> {
    if (this.#closed) return failure('io', 'The socket is closed.');
    if (!this.#common.has(method)) return failure('unsupported', `${method} was not negotiated.`);
    if (this.#pending.size >= limits.pending - (control(method) ? 0 : limits.controlReserve)) return failure('budget', 'The socket request pool is full.');
    const id = String(++this.#id); const timer = new AbortController();
    const answer = new Promise<Result<unknown>>(resolve => { this.#pending.set(id, { finish: resolve, timer }); });
    const deadline = this.#clock.wait(timeoutMs, timer.signal).then(() => { if (!timer.signal.aborted) this.#complete(id, failure('deadline', `${method} exceeded its deadline.`)); });
    void this.#writer.write({ id, method, params }, control(method)).then(result => { if (!result.ok) this.#complete(id, result); });
    const result = await answer; timer.abort(); await deadline;
    return result;
  }

  notify(value: Note): Promise<Result<void>> {
    if (!this.#common.has(value.note)) return Promise.resolve(failure('unsupported', `${value.note} was not negotiated.`));
    return this.#writer.write(value, value.note === 'run.stop');
  }

  async #read(): Promise<Result<void>> {
    let bytes = 0; let window = this.#clock.now();
    try {
      for await (const incoming of this.#frames) {
        if (!incoming.ok) { await this.#writer.write({ id: 'frame', error: incoming.error }, true); return incoming; }
        if (this.#clock.now() - window >= limits.windowMs) { bytes = 0; window = this.#clock.now(); }
        bytes += Buffer.byteLength(JSON.stringify(incoming.value));
        if (bytes > limits.incomingBytes) return failure('budget', 'The socket input window is full.');
        if (!this.#check(incoming.value)) { await this.#invalid(incoming.value); continue; }
        const frame = incoming.value;
        if (response(frame)) this.#response(frame);
        else if (note(frame)) {
          if (!this.#common.has(frame.note)) return failure('unsupported', `${frame.note} was not negotiated.`);
          const observed = await this.#callbacks.note(frame); if (!observed.ok) return observed;
        } else {
          if (this.#handlers.size >= limits.handlers - (control(frame.method) ? 0 : limits.controlReserve)) { await this.#writer.write({ id: frame.id, error: { code: 'budget', message: 'The socket handler pool is full.' } }, true); continue; }
          const handling = this.#request(frame); this.#handlers.add(handling);
          void handling.then(result => { this.#handlers.delete(handling); if (!result.ok) { this.#fault = result; this.close(); } });
        }
      }
      return this.#fault ?? { ok: true, value: undefined };
    } catch { return this.#fault ?? failure('io', 'The socket read failed.'); }
    finally { this.close(); }
  }

  async #invalid(value: unknown): Promise<void> {
    if (isObject(value) && typeof value['id'] === 'string') {
      const code = typeof value['method'] === 'string' && !this.#common.has(value['method']) ? 'unsupported' : 'invalid-args';
      await this.#writer.write({ id: value['id'], error: { code, message: 'The frame is unsupported or violates its schema.' } }, true);
    }
  }

  async #request(frame: Request): Promise<Result<void>> {
    const handler = this.#common.has(frame.method) ? this.#callbacks.handlers.get(frame.method) : undefined;
    try {
      const result = handler ? await handler(frame.params) : failure('unsupported', `${frame.method} was not negotiated.`);
      return await this.#writer.write(result.ok ? { id: frame.id, result: result.value ?? null } : { id: frame.id, error: result.error }, control(frame.method));
    } catch { return this.#writer.write({ id: frame.id, error: { code: 'io', message: 'The request handler failed.' } }, true); }
  }

  #response(frame: Response): void {
    if (isObject(frame['error']) && typeof frame['error']['code'] === 'string' && typeof frame['error']['message'] === 'string') this.#complete(frame.id, failure(frame['error']['code'], frame['error']['message']));
    else this.#complete(frame.id, { ok: true, value: frame['result'] });
  }
  #complete(id: string, result: Result<unknown>): void {
    const pending = this.#pending.get(id); if (!pending) return;
    this.#pending.delete(id); pending.timer.abort(); pending.finish(result);
  }
  close(): void {
    if (this.#closed) return; this.#closed = true; this.#writer.close(); this.#socket.destroy();
    for (const id of this.#pending.keys()) this.#complete(id, failure('io', 'The socket closed before the request completed.'));
  }
  finished(): Promise<Result<void>> { return this.#reading ?? Promise.resolve(failure('io', 'The socket was not negotiated.')); }
}
