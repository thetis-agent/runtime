/** Preserve startup and drain ordering while callers project health and admit notes; ADR 0010, GN-004. */
import type { Method, Note } from '@/contracts/kernel-socket/types.ts';
import type { Result } from '@/lib/schema/index.ts';
import type { Handler } from '@/lib/socket/index.ts';
import type { Service } from './lifecycle.ts';

type Controlled = Pick<Service, 'ready' | 'connections' | 'paused' | 'pause' | 'resume' | 'stop'>;
type Health = (service: Controlled | undefined, stopping: boolean) => Record<string, unknown>;

export class Control {
  service: Controlled | undefined;
  readonly #started = Promise.withResolvers<Result<void>>();
  readonly #health: Health;
  readonly #unhandledNote: Result<void>;
  #pausing: Promise<Result<void>> | undefined;
  #stopping = false;
  readonly handlers = new Map<Method, Handler>([['health.probe', async () => {
    const ready = await this.#started.promise; if (!ready.ok) return ready;
    const paused = await this.#pausing; if (paused && !paused.ok) return paused;
    return { ok: true, value: this.#health(this.service, this.#stopping) };
  }]]);

  constructor(health: Health, unhandledNote: Result<void>) {
    this.#health = health; this.#unhandledNote = unhandledNote;
  }

  ready(result: Result<void>, service?: Controlled): void {
    if (service) {
      this.service = service;
      if (this.#stopping) this.#pausing = service.pause();
    }
    this.#started.resolve(result);
  }

  async note(note: Note): Promise<Result<void>> {
    if (note.note === 'run.stop') { this.#stopping = true; this.#pausing ??= this.service?.pause(); }
    else if (note.note === 'env.updated' && note.params['resume'] === true && this.service) {
      const resumed = await this.service.resume(); if (!resumed.ok) return resumed;
      this.#pausing = undefined; this.#stopping = false;
    } else return this.#unhandledNote;
    return { ok: true, value: undefined };
  }
}
