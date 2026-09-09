/** Keep health responsive while a late package is made inert; ADR 0027, TE-022. */
import { Worker } from 'node:worker_threads';
import type { Clock } from '../../lib/events/index.ts';
import type { Schemas, Result } from '../../lib/schema/index.ts';
import { failure } from '../../lib/schema/index.ts';
import { limits, validator } from '../../lib/package-loader/index.ts';
import type { Setup, WorkerMessage, Registration } from '../../lib/package-loader/types.ts';
import { gap } from '../../lib/semver-match/index.ts';
import { encode } from '../../lib/ndjson/index.ts';

export interface Initialization {
  sources: readonly string[];
  gaps: readonly string[];
  registrations: ReadonlyMap<string, Registration>;
  notices: readonly Extract<WorkerMessage, { type: 'notice' }>[];
  failures: ReadonlyMap<string, string>;
}
type Code = Extract<WorkerMessage, { type: 'refused' }>['error']['code'];
type Round = { ok: true; worker: Worker; result: Initialization } | { ok: false; source: string; message: string; code: Code };
export class Initializer {
  readonly #clock: Clock;
  readonly #schemas: Schemas;
  readonly #observe: (message: WorkerMessage) => void;
  #worker: Worker | undefined;
  #source: string | undefined;
  #starting = false;
  #stopping = false;
  constructor(clock: Clock, schemas: Schemas, observe: (message: WorkerMessage) => void = () => {}) { this.#clock = clock; this.#schemas = schemas; this.#observe = observe; }
  status(): { ready: true; initializing: string | undefined } { return { ready: true, initializing: this.#source }; }

  async start(setup: Setup): Promise<Result<Initialization>> {
    if (this.#starting || this.#worker) return failure('switching', 'The environment is already initializing or live.');
    this.#starting = true; const excluded = new Set(setup.excluded); const gaps: string[] = []; const failures = new Map<string, string>();
    try {
      const check = await validator<Setup>(this.#schemas, 'setup');
      if (!encode(setup, limits.messageBytes).ok || !check(setup)) return failure('budget', 'The environment setup exceeds its validated limit.');
      for (let attempt = 0; attempt <= setup.entries.length && !this.#halted(); attempt++) {
        const round = await this.#round({ ...setup, excluded: [...excluded] });
        if (round.ok) {
          if (this.#stopping) { await round.worker.terminate(); return failure('io', 'The environment initialization was stopped.'); }
          this.#worker = round.worker; return { ok: true, value: { ...round.result, gaps, failures } };
        }
        const entry = setup.entries.find(entry => `${entry.manifest.name}@${entry.manifest.version}` === round.source);
        if (!entry || excluded.has(round.source)) return failure('io', round.message);
        excluded.add(round.source); failures.set(round.source, round.message); gaps.push(gap(entry.manifest, round.code === 'deadline' ? 'cap/init.within-probe' : 'cap/init.valid', '*'));
      }
      return failure('io', 'The environment initialization was stopped.');
    } finally { this.#starting = false; this.#source = undefined; }
  }

  async #round(setup: Setup): Promise<Round> {
    const check = await validator<WorkerMessage>(this.#schemas, 'workerMessage');
    if (this.#stopping) return { ok: false, source: '', message: 'The environment initialization was stopped.', code: 'io' };
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { workerData: setup }); this.#worker = worker;
    const done = Promise.withResolvers<Round>(); const registrations = new Map<string, Registration>(); const notices: Extract<WorkerMessage, { type: 'notice' }>[] = [];
    let timer = new AbortController(); let messages = 0; let source = '';
    const refused = (message: string, code: Code = 'io') => { done.resolve({ ok: false, source, message, code }); };
    const deadline = () => {
      timer.abort(); timer = new AbortController(); const signal = timer.signal;
      void this.#clock.wait(limits.probeMs, signal).then(() => { if (!signal.aborted) refused('The package initialization exceeded its probe budget.', 'deadline'); });
    };
    deadline();
    worker.on('message', (value: unknown) => {
      if (++messages > limits.messages || !encode(value, limits.messageBytes).ok || !check(value)) { refused('The initialization message violates its boundary.'); return; }
      switch (value.type) {
        case 'initializing': source = value.source; this.#source = source; deadline(); break;
        case 'registration': registrations.set(value.source, value.registration); break;
        case 'notice': notices.push(value); break;
        case 'refused': source = value.source; refused(value.error.message, value.error.code); break;
        case 'ready': done.resolve({ ok: true, worker, result: { sources: value.sources, gaps: [], registrations, notices, failures: new Map() } }); break;
      }
      this.#observe(structuredClone(value));
    });
    worker.once('error', () => { refused('The environment worker failed during initialization.'); });
    worker.once('exit', () => { refused('The environment worker exited during initialization.'); });
    const result = await done.promise; timer.abort();
    if (!result.ok) { await worker.terminate(); this.#worker = undefined; }
    return result;
  }

  async stop(): Promise<void> { this.#stopping = true; await this.#worker?.terminate(); this.#worker = undefined; }
  #halted(): boolean { return this.#stopping; }
}
