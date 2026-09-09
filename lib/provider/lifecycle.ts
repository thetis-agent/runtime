/** Bound incomplete connections and drain without restarting a service; PR-001, ADR 0010. */
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import type { Clock } from '../events/index.ts';
import type { Result } from '../schema/index.ts';
import { failure } from '../schema/index.ts';

export const serviceLimits = { connections: 64, probeMs: 10000, exchangeMs: 600000, drainMs: 30000 };
export interface Connection {
  socket: Socket;
  admitted: () => void;
}
type Session = { socket: Socket; finished: Promise<void> };

export class Service {
  readonly #server = createServer();
  readonly #sessions = new Set<Session>();
  readonly #clock: Clock;
  readonly #limits: typeof serviceLimits;
  #stopping: Promise<Result<void>> | undefined;
  #closed = false;
  constructor(clock: Clock, limits = serviceLimits) {
    if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('The service limits must be positive integers.');
    this.#clock = clock; this.#limits = { ...limits };
  }

  get connections(): number { return this.#sessions.size; }
  get ready(): boolean { return this.#server.listening && !this.#closed; }

  open(path: string, serve: (connection: Connection) => Promise<Result<void>>, observe: (outcome: Result<void>) => void): Promise<Result<void, 'provider'>> {
    this.#server.on('connection', socket => {
      socket.on('error', () => { socket.destroy(); });
      if (this.#closed || this.#sessions.size >= this.#limits.connections) { socket.destroy(); return; }
      const session: Session = { socket, finished: Promise.resolve() };
      this.#sessions.add(session);
      session.finished = this.#serve(socket, serve, observe).finally(() => { this.#sessions.delete(session); });
    });
    return new Promise(resolve => {
      this.#server.on('error', () => { this.#closed = true; resolve(failure('provider', 'The provider socket could not be opened.')); });
      this.#server.listen(path, () => { resolve({ ok: true, value: undefined }); });
    });
  }

  async #serve(socket: Socket, serve: (connection: Connection) => Promise<Result<void>>, observe: (outcome: Result<void>) => void): Promise<void> {
    const probe = new AbortController(); const exchange = new AbortController();
    const state = { expired: false }; let admitted = false;
    const expire = (): void => { state.expired = true; socket.destroy(); };
    const probing = this.#clock.wait(this.#limits.probeMs, probe.signal).then(() => { if (!probe.signal.aborted) expire(); });
    let exchanging: Promise<void> | undefined;
    const connection: Connection = { socket, admitted: () => {
      if (admitted) return; admitted = true; probe.abort();
      exchanging = this.#clock.wait(this.#limits.exchangeMs, exchange.signal).then(() => { if (!exchange.signal.aborted) expire(); });
    } };
    let outcome: Result<void>;
    try { outcome = await serve(connection); }
    catch { outcome = failure('provider', 'The provider connection failed.'); }
    finally { probe.abort(); exchange.abort(); socket.destroy(); await probing; if (exchanging) await exchanging; }
    observe(state.expired ? failure('deadline', 'The provider connection exceeded its deadline.') : outcome);
  }

  stop(): Promise<Result<void>> {
    this.#stopping ??= this.#drain();
    return this.#stopping;
  }

  async #drain(): Promise<Result<void>> {
    this.#closed = true;
    const closed = new Promise<void>(resolve => { this.#server.close(() => { resolve(); }); });
    const timer = new AbortController();
    const finished = Promise.all([...this.#sessions].map(session => session.finished)).then(() => true);
    const drained = await Promise.race([finished, this.#clock.wait(this.#limits.drainMs, timer.signal).then(() => false)]);
    timer.abort();
    if (!drained) for (const session of this.#sessions) session.socket.destroy();
    await closed;
    return drained ? { ok: true, value: undefined } : failure('deadline', 'The provider did not drain within its deadline.');
  }
}
