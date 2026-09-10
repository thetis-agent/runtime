/** Apply trusted kernel upgrades through the shared generation machine and preserve the serving binary on probe refusal; GN-007. */
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Endpoint } from '@/lib/socket/endpoint.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Result, Schemas } from '@/lib/schema/index.ts';
import type { Clock } from '@/lib/events/index.ts';
import type { Generations, Generation, Input, View } from '@/kernel/generations/index.ts';
import { prepare } from './prepare.ts';
import type { Revision, Prepared, Capture } from './prepare.ts';
import { KernelProcess } from './process.ts';
import { probe } from './probe.ts';
import type { Principal } from './types.ts';
import { hashes, load, save, retained, revisionOf, publish, retire } from './checkpoint.ts';
import type { Retained, Recovered } from './checkpoint.ts';
export type { Revision, Capture } from './prepare.ts';
export type { Principal } from './types.ts';
export const maintenanceLimits = { attempts: 128 };
export interface Configuration {
  root: string; schemas: Schemas; clock: Clock; administrator: string; currentMajor: string;
  capture: Capture;
  /** A short root for each generation's private store; nesting it under the run workspace exceeds the unix socket path limit for target endpoints (implementation note 0050). */
  stateRoot?: string;
  durable?: boolean;
  machine(initial: Generation, recovered?: View): Generations;
  initial?(view: View): Promise<Result<void>>;
  descriptors?(): Promise<Result<readonly number[]>>;
}
interface Live { prepared: Prepared; process: KernelProcess; revision: Revision }
export class Maintenance {
  readonly machine: Generations;
  readonly #config: Configuration; readonly #endpoint: Endpoint;
  #previous: Retained | undefined;
  #live: Live; #next: Live | undefined; #busy = false; #stopped = false; #attempt: string | undefined; #captured: string | undefined; #store: string | undefined; #attempts = 0;
  private constructor(config: Configuration, endpoint: Endpoint, machine: Generations, live: Live) { this.#config = config; this.#endpoint = endpoint; this.machine = machine; this.#live = live; }
  get endpoint(): string { return this.#endpoint.path; }
  /** The live kernel's root, so an operator tool can name the public socket paths that move with each generation (implementation note 0050). */
  get state(): string { return this.#live.prepared.state; }
  get release(): string | undefined { return this.#live.revision.release; }
  get previousRelease(): string | undefined { return this.#previous?.release; }
  static async start(config: Configuration, revision: Revision, state: string): Promise<Result<Maintenance>> {
    await mkdir(config.root, { recursive: true, mode: 0o700 });
    const endpoint = await Endpoint.open(join(config.root, 'runs')); if (!endpoint.ok) return endpoint;
    if (config.durable) {
      const recovered = await load(config.root, config.stateRoot, config.schemas); if (!recovered.ok) return recovered;
      if (recovered.value) return Maintenance.#restore(config, endpoint.value, recovered.value);
    }
    const prepared = await prepare(join(config.root, 'runs/1'), state, revision, config.capture, store(config, 1)); if (!prepared.ok) return prepared;
    const launched = await launch(config, prepared.value, 'serve'); if (!launched.ok) return launched;
    const checked = await probe(prepared.value.endpoint, config.currentMajor, config.schemas, config.clock);
    const pointed = checked.ok ? await endpoint.value.repoint(prepared.value.endpoint) : checked;
    if (!pointed.ok) { const stopped = await launched.value.stop(); return stopped.ok ? pointed : stopped; }
    const initial = { n: 1, pins: hashes(revision), stateSnapshot: prepared.value.hash, prefixRenderer: '1', at: config.clock.now() };
    const live = new Maintenance(config, endpoint.value, config.machine(initial), { prepared: prepared.value, process: launched.value, revision: pinned(revision, prepared.value) });
    const recorded = await live.#checkpoint();
    const observed = recorded.ok && config.initial ? await config.initial(live.machine.view) : recorded;
    const published = observed.ok ? await live.#publish() : observed;
    if (!published.ok) { await live.close(); return published; }
    return { ok: true, value: live };
  }

  static async #restore(config: Configuration, endpoint: Endpoint, recovered: Recovered): Promise<Result<Maintenance>> {
    const machine = config.machine(recovered.view.current, recovered.view);
    if (machine.view.state === 'FAILED') return failure('conflict', 'The kernel is FAILED; inspect its observed history before a recovery reset.');
    const restoring = await machine.transition({ event: 'restart', authorized: true, candidate: machine.view.current, reason: 'supervisor recovery of the last serving store' });
    if (!restoring.ok) return restoring;
    const prepared = await prepare(join(config.root, 'runs', `recovery-${randomUUID()}`), recovered.live.prepared.state, recovered.revision, config.capture, store(config, machine.view.current.n, 'r')); if (!prepared.ok) return prepared;
    const launched = await launch(config, prepared.value, 'serve'); if (!launched.ok) return launched;
    const checked = await probe(prepared.value.endpoint, config.currentMajor, config.schemas, config.clock);
    const pointed = checked.ok ? await endpoint.repoint(prepared.value.endpoint) : checked;
    if (!pointed.ok) { await launched.value.stop(); return pointed; }
    const live = new Maintenance(config, endpoint, machine, { prepared: prepared.value, process: launched.value, revision: pinned(recovered.revision, prepared.value) });
    live.#previous = recovered.previous;
    const restored = await live.#move({ event: 'restored', restored: true, probed: true, reason: 'retained kernel code and serving store recovered' });
    const published = restored.ok ? await live.#settled() : restored;
    if (!published.ok) { await live.close(); return published; }
    return { ok: true, value: live };
  }
  async upgrade(revision: Revision, baseline: number, authorized: boolean, undo = false): Promise<Result<void>> {
    if (this.#busy) return failure('switching', 'The kernel is already switching.');
    if (++this.#attempts > maintenanceLimits.attempts) return failure('budget', 'The kernel maintenance attempt limit is exhausted.');
    this.#busy = true;
    try {
      const candidate = { ...this.machine.view.current, pins: hashes(revision) };
      const begun = await this.#move({ event: undo ? 'undo' : 'switch', candidate, baseline, authorized, reason: 'administrator maintenance command' }); if (!begun.ok) return begun;
      return await this.#upgrade(revision, undo ? this.#previous?.prepared.state : undefined);
    } catch {
      return this.machine.view.state === 'LIVE' ? failure('io', 'The kernel is serving, but maintenance retention could not finish; inspect status before retrying.')
        : await this.#rollback('The kernel maintenance operation failed.');
    }
    finally { this.#busy = false; }
  }
  async #upgrade(revision: Revision, restoredState?: string): Promise<Result<void>> {
    const clients = await this.#live.process.clients(); if (!clients.ok) return this.#rollback(clients.error.message);
    const paused = await this.#live.process.call('pause'); if (!paused.ok) return this.#rollback(paused.error.message);
    const frozen = await this.#live.process.freeze(true); if (!frozen.ok) return this.#rollback(frozen.error.message);
    const drained = await this.#move({ event: 'drained', active: 0, reason: 'kernel admissions drained and writers stopped' }); if (!drained.ok) return this.#rollback(drained.error.message);
    const n = this.machine.view.current.n + 1; const attempt = `${String(n)}-${randomUUID()}`; this.#attempt = join(this.#config.root, 'runs', attempt); this.#captured = join(this.#config.root, `snapshot-${attempt}`);
    this.#store = store(this.#config, n);
    const captured = await this.#config.capture(this.#live.prepared.state, this.#captured); if (!captured.ok) return this.#rollback(captured.error.message);
    const saved = await this.#move({ event: 'snapshot', snapshot: captured.value, snapshotVerified: true, reason: 'stopped kernel store exported' }); if (!saved.ok) return this.#rollback(saved.error.message);
    const prepared = await prepare(this.#attempt, restoredState ?? this.#captured, revision, this.#config.capture, this.#store); if (!prepared.ok) return this.#rollback(prepared.error.message);
    const applied = await this.#move({ event: 'applied', pinsVerified: true, migrationsPassed: true, formatValid: true, reason: 'kernel pins and private store verified' }); if (!applied.ok) return this.#rollback(applied.error.message);
    const launched = await launch(this.#config, prepared.value, 'probe'); if (!launched.ok) return this.#rollback(launched.error.message);
    this.#next = { prepared: prepared.value, process: launched.value, revision: pinned(revision, prepared.value) };
    const savedRun = await this.#checkpoint(retained(n, prepared.value, revision)); if (!savedRun.ok) return this.#rollback(savedRun.error.message);
    for (const major of new Set([this.#config.currentMajor, ...clients.value])) {
      const compatible = await probe(prepared.value.endpoint, major, this.#config.schemas, this.#config.clock); if (!compatible.ok) return this.#rollback(compatible.error.message);
    }
    const healthy = await this.#move({ event: 'healthy', probed: true, clientCompatible: true, reason: 'private kernel health and actual client majors accepted' }); if (!healthy.ok) return this.#rollback(healthy.error.message);
    this.#stopped = true; const stopped = await this.#live.process.stop(); if (!stopped.ok) return this.#rollback(stopped.error.message);
    const activated = await launched.value.call('activate'); if (!activated.ok) return this.#rollback(activated.error.message);
    const pointed = await this.#endpoint.repoint(prepared.value.endpoint); if (!pointed.ok) return this.#rollback(pointed.error.message);
    const committed = await this.#move({ event: 'repointed', atomic: true, stop: true, reason: 'kernel endpoint atomically promoted' }); if (!committed.ok) return this.#rollback(committed.error.message);
    this.#previous = retained(n - 1, this.#live.prepared, this.#live.revision);
    this.#live = this.#next; this.#next = undefined; this.#stopped = false;
    this.#attempt = undefined; this.#captured = undefined; this.#store = undefined;
    return this.#settled();
  }
  async #rollback(reason: string): Promise<Result<void>> {
    const moved = await this.#move(this.machine.view.state === 'QUIESCING' ? { event: 'restart', reason, authorized: true, candidate: this.machine.view.current } : { event: 'failed', reason }); if (!moved.ok) return moved;
    if (this.#next) { const stopped = await this.#next.process.stop(); if (!stopped.ok) return this.#failed(stopped.error.message); this.#next = undefined; }
    if (this.#stopped) {
      if (!this.#captured) return this.#failed('The stopped kernel recovery snapshot is absent.');
      const prepared = await prepare(join(this.#config.root, 'runs', `recovery-${randomUUID()}`), this.#captured, this.#live.revision, this.#config.capture, store(this.#config, this.machine.view.current.n, 'r')); if (!prepared.ok) return this.#failed(prepared.error.message);
      const restored = await launch(this.#config, prepared.value, 'serve'); if (!restored.ok) return this.#failed(restored.error.message);
      this.#live = { prepared: prepared.value, process: restored.value, revision: pinned(this.#live.revision, prepared.value) }; const pointed = await this.#endpoint.repoint(this.#live.prepared.endpoint); if (!pointed.ok) return this.#failed(pointed.error.message);
    } else {
      const resumed = await this.#live.process.freeze(false); if (!resumed.ok) return this.#failed(resumed.error.message);
      const serving = await this.#live.process.call('resume'); if (!serving.ok) return this.#failed(serving.error.message);
    }
    const healthy = await probe(this.endpoint, this.#config.currentMajor, this.#config.schemas, this.#config.clock); if (!healthy.ok) return this.#failed(healthy.error.message);
    if (this.#attempt) await rm(this.#attempt, { recursive: true, force: true });
    if (this.#captured) await rm(this.#captured, { recursive: true, force: true });
    if (this.#store) await rm(this.#store, { recursive: true, force: true });
    this.#attempt = undefined; this.#captured = undefined; this.#store = undefined;
    const restored = await this.#move({ event: 'restored', restored: true, probed: true, reason: 'old kernel keeps serving' }); this.#stopped = false;
    if (restored.ok) { const saved = await this.#settled(); if (!saved.ok) return saved; }
    return restored.ok ? failure('unsupported', reason) : restored;
  }
  async #failed(reason: string): Promise<Result<void>> { const failed = await this.#move({ event: 'failed', reason }); return failed.ok ? failure('io', reason) : failed; }
  async #move(input: Input): Promise<Result<void>> { const moved = await this.machine.transition(input); return moved.ok ? { ok: true, value: undefined } : moved; }
  /** Only the running kernel resolves a session; the supervisor reads its answer (ADR 0048, AGENTS.md identity rule). */
  whois(session: string): Promise<Result<Principal>> { return this.#live.process.whois(session); }
  async undo(baseline: number, authorized: boolean): Promise<Result<void>> {
    if (!this.#previous) return failure('invalid-args', 'There is no retained kernel generation to undo to.');
    const revision = await revisionOf(this.#previous, this.#config.root, this.#config.stateRoot, this.#config.schemas);
    return revision.ok ? this.upgrade(revision.value, baseline, authorized, true) : revision;
  }
  async prune(): Promise<Result<number>> {
    if (this.#busy || this.machine.view.state !== 'LIVE') return failure('conflict', 'No maintenance run is retired during a transaction.');
    this.#busy = true;
    try { return await retire(this.#config.root, this.#config.stateRoot, [retained(this.machine.view.current.n, this.#live.prepared, this.#live.revision), ...this.#previous ? [this.#previous] : []]); }
    finally { this.#busy = false; }
  }
  #checkpoint(next?: Retained): Promise<Result<void>> {
    return this.#config.durable ? save(this.#config.root, { version: 1, live: retained(this.machine.view.current.n, this.#live.prepared, this.#live.revision), ...this.#previous ? { previous: this.#previous } : {}, ...next ? { next } : {} }) : Promise.resolve({ ok: true, value: undefined });
  }
  #publish(): Promise<Result<void>> {
    return this.#config.durable ? publish(join(this.#config.root, '..'), this.state) : Promise.resolve({ ok: true, value: undefined });
  }
  async #settled(): Promise<Result<void>> {
    const saved = await this.#checkpoint(); if (!saved.ok) return saved;
    const published = await this.#publish(); if (!published.ok) return published;
    const retired = await retire(this.#config.root, this.#config.stateRoot, [retained(this.machine.view.current.n, this.#live.prepared, this.#live.revision), ...this.#previous ? [this.#previous] : []]);
    return retired.ok ? { ok: true, value: undefined } : retired;
  }
  close(): Promise<Result<void>> { return this.#live.process.stop(); }
}

/** Names stay short so a copied kernel root still leaves room for its targets' 107-byte endpoint paths (implementation note 0050). */
function store(config: Configuration, n: number, kind = 'g'): string | undefined {
  return config.stateRoot === undefined ? undefined : join(config.stateRoot, `${kind}${String(n)}-${randomUUID().slice(0, 8)}`);
}

function pinned(revision: Revision, prepared: Prepared): Revision { return { ...revision, pins: Object.fromEntries(Object.entries(revision.pins).map(([name, pin]) => [name, { ...pin, source: join(prepared.root, 'code', name) }])) }; }
async function launch(config: Configuration, prepared: Prepared, mode: 'probe' | 'serve'): Promise<Result<KernelProcess>> {
  const descriptors = await config.descriptors?.(); if (descriptors && !descriptors.ok) return descriptors;
  return KernelProcess.start({ ...prepared, configuration: prepared.configuration, administrator: config.administrator, mode, ...(descriptors?.ok ? { descriptors: descriptors.value } : {}) }, config.schemas, config.clock);
}
