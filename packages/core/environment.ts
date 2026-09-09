/** Keep the monitor responsive while the worker owns sessions and provider content; ADR 0027, KS-004. */
import { Initializer } from './initialization.ts';
import type { Initialization } from './initialization.ts';
import { privateEndpoint } from '../../lib/socket/private.ts';
import type { PrivateEndpoint } from '../../lib/socket/private.ts';
import { Peer } from '../../lib/socket/index.ts';
import type { Schemas, Result } from '../../lib/schema/index.ts';
import { failure } from '../../lib/schema/index.ts';
import type { Clock } from '../../lib/events/index.ts';
import type { Setup, WorkerMessage } from '../../lib/package-loader/types.ts';
import type { Method, Note } from '../../contracts/kernel-socket/types.ts';
import { capabilities } from './protocol.ts';
export const controlLimits = { turnMs: 600000, probeMs: 10000 };

export class Environment {
  readonly #initializer: Initializer;
  readonly #schemas: Schemas;
  readonly #clock: Clock;
  #endpoint: PrivateEndpoint | undefined;
  #peer: Peer | undefined;
  #started = false;
  #closed = false;
  #live = false;
  #fault = false;
  readonly #ended = Promise.withResolvers<Result<void>>();
  #closing: Promise<Result<void>> | undefined;
  constructor(schemas: Schemas, clock: Clock, observe: (message: WorkerMessage) => void = () => {}) {
    this.#schemas = schemas; this.#clock = clock; this.#initializer = new Initializer(clock, schemas, observe);
    void this.#initializer.finished().then(result => { this.#ended.resolve(result); });
  }

  status(): { ready: boolean; initializing: string | undefined } {
    const status = this.#initializer.status(); return { ...status, ready: status.ready && !this.#fault };
  }
  finished(): Promise<Result<void>> { return this.#ended.promise; }

  async start(setup: Setup): Promise<Result<Initialization>> {
    if (this.#started || this.#closed) return failure('switching', 'The environment monitor has already started or stopped.');
    if (!setup.runtime) return failure('invalid-args', 'The environment runtime is absent.');
    this.#started = true;
    const endpoint = await privateEndpoint(); if (!endpoint.ok) return endpoint;
    this.#endpoint = endpoint.value;
    if (this.#halted()) { await endpoint.value.close(); return failure('switching', 'The environment monitor is stopped.'); }
    const runtime = { ...setup.runtime, controlPath: endpoint.value.path };
    const accepting = endpoint.value.accepted.then(async socket => {
      if (!socket.ok) return socket;
      this.#peer = new Peer(socket.value, this.#schemas, this.#clock, capabilities, { handlers: new Map(), note: () => Promise.resolve(failure('forbidden', 'The worker cannot send monitor authority notes.')) });
      const accepted = await this.#peer.accept({ person: runtime.person, scope: 'person' });
      if (accepted.ok) void this.#peer.finished().then(() => {
        if (!this.#closed) { this.#fault = true; this.#ended.resolve(failure('io', 'The environment worker control endpoint closed.')); }
      });
      return accepted;
    });
    const initialized = await this.#initializer.start({ ...setup, runtime });
    if (!initialized.ok) { const closed = await this.close(); await accepting; return closed.ok ? initialized : closed; }
    const accepted = await accepting;
    if (!accepted.ok) { const closed = await this.close(); return closed.ok ? accepted : closed; }
    this.#live = true;
    return initialized;
  }

  call(method: Method, params: Record<string, unknown>, timeoutMs = method === 'session.submit' ? controlLimits.turnMs : controlLimits.probeMs): Promise<Result<unknown>> {
    if (!this.#peer || !this.#live || this.#closed || !this.status().ready) return Promise.resolve(failure('switching', 'The environment is not admitting session control.'));
    return this.#peer.call(method, params, timeoutMs);
  }

  notify(note: Note): Promise<Result<void>> {
    return this.#peer && !this.#closed ? this.#peer.notify(note) : Promise.resolve(failure('switching', 'The environment control endpoint is unavailable.'));
  }

  close(): Promise<Result<void>> { this.#closing ??= this.#close(); return this.#closing; }
  async #close(): Promise<Result<void>> {
    this.#closed = true; this.#peer?.close(); await this.#initializer.stop();
    const closed = await this.#endpoint?.close(); if (this.#peer) await this.#peer.finished();
    return closed ?? { ok: true, value: undefined };
  }
  #halted(): boolean { return this.#closed; }
}
