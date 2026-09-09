/** Hold session admission until initialization is settled, while keeping health and stop responsive; ADR 0027. */
import type { Method, Note } from '../../contracts/kernel-socket/types.ts';
import type { Handler } from '../../lib/socket/index.ts';
import type { Result } from '../../lib/schema/index.ts';
import { failure } from '../../lib/schema/index.ts';
import { Queue } from '../../lib/events/queue.ts';
import type { Environment } from './environment.ts';
import { sessionMethods } from './protocol.ts';

export const startupLimits = { notes: 256, noteBytes: 65536, drainMs: 30000, probeMs: 10000 };

export class KernelControl {
  readonly #environment: Environment;
  readonly #ready = Promise.withResolvers<Result<void>>();
  readonly #notes = new Queue<Note>({ entries: startupLimits.notes, bytes: startupLimits.noteBytes });
  #initialized = false;
  #stopping = false;
  #fault: Result<void> | undefined;
  constructor(environment: Environment) { this.#environment = environment; }

  handlers(): ReadonlyMap<Method, Handler> {
    const handlers = new Map<Method, Handler>();
    for (const method of sessionMethods) handlers.set(method, async params => {
      const ready = await this.#ready.promise;
      return ready.ok ? this.#environment.call(method, params) : ready;
    });
    handlers.set('health.probe', async () => {
      if (this.#fault && !this.#fault.ok) return this.#fault;
      if (this.#stopping) { const ready = await this.#ready.promise; if (!ready.ok) return ready; }
      return this.#initialized ? this.#environment.call('health.probe', {}, this.#stopping ? startupLimits.drainMs : startupLimits.probeMs) : { ok: true, value: { ...this.#environment.status(), admitting: false } };
    });
    return handlers;
  }

  note(note: Note): Promise<Result<void>> {
    if (note.note !== 'run.stop' && note.note !== 'env.updated') return Promise.resolve(failure('forbidden', 'This note is not a kernel environment control.'));
    if (note.note === 'run.stop') this.#stopping = true;
    if (note.note === 'env.updated' && note.params['resume'] === true) this.#stopping = false;
    return this.#initialized ? this.#environment.notify(note) : Promise.resolve(this.#notes.push(note, Buffer.byteLength(JSON.stringify(note))));
  }

  async ready(result: Result<void>): Promise<Result<void>> {
    this.#notes.close();
    if (!result.ok) { this.#fault = result; this.#ready.resolve(result); return result; }
    this.#initialized = true;
    for await (const note of this.#notes) {
      const sent = await this.#environment.notify(note);
      if (!sent.ok) { this.#fault = sent; this.#ready.resolve(sent); return sent; }
    }
    this.#ready.resolve(result); return result;
  }
}
