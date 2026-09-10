/** Apply trusted kernel upgrades through the shared generation machine and preserve the serving binary on probe refusal; GN-007. */
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Endpoint } from '../socket/endpoint.ts';
import { failure } from '../schema/index.ts';
import type { Result, Schemas } from '../schema/index.ts';
import type { Clock } from '../events/index.ts';
import type { Generations, Generation, Input } from '../../kernel/generations/index.ts';
import { prepare } from './prepare.ts';
import type { Revision, Prepared, Capture } from './prepare.ts';
import { KernelProcess } from './process.ts';
import { probe } from './probe.ts';
export type { Revision, Capture } from './prepare.ts';
export const maintenanceLimits = { attempts: 128 };
export interface Configuration {
  root: string; schemas: Schemas; clock: Clock; administrator: string; currentMajor: string;
  capture: Capture;
  machine(initial: Generation): Generations;
  descriptors?(): Promise<Result<readonly number[]>>;
}
interface Live { prepared: Prepared; process: KernelProcess; revision: Revision }
export class Maintenance {
  readonly machine: Generations;
  readonly #config: Configuration; readonly #endpoint: Endpoint;
  #live: Live; #next: Live | undefined; #busy = false; #stopped = false; #attempt: string | undefined; #captured: string | undefined; #attempts = 0;
  private constructor(config: Configuration, endpoint: Endpoint, machine: Generations, live: Live) { this.#config = config; this.#endpoint = endpoint; this.machine = machine; this.#live = live; }
  get endpoint(): string { return this.#endpoint.path; }
  static async start(config: Configuration, revision: Revision, state: string): Promise<Result<Maintenance>> {
    await mkdir(config.root, { recursive: true, mode: 0o700 });
    const endpoint = await Endpoint.open(join(config.root, 'runs')); if (!endpoint.ok) return endpoint;
    const prepared = await prepare(join(config.root, 'runs/1'), state, revision, config.capture); if (!prepared.ok) return prepared;
    const launched = await launch(config, prepared.value, 'serve'); if (!launched.ok) return launched;
    const checked = await probe(prepared.value.endpoint, config.currentMajor, config.schemas, config.clock);
    const pointed = checked.ok ? await endpoint.value.repoint(prepared.value.endpoint) : checked;
    if (!pointed.ok) { const stopped = await launched.value.stop(); return stopped.ok ? pointed : stopped; }
    const initial = { n: 1, pins: hashes(revision), stateSnapshot: prepared.value.hash, prefixRenderer: '1', at: config.clock.now() };
    return { ok: true, value: new Maintenance(config, endpoint.value, config.machine(initial), { prepared: prepared.value, process: launched.value, revision: pinned(revision, prepared.value) }) };
  }
  async upgrade(revision: Revision, baseline: number, authorized: boolean): Promise<Result<void>> {
    if (this.#busy) return failure('switching', 'The kernel is already switching.');
    if (++this.#attempts > maintenanceLimits.attempts) return failure('budget', 'The kernel maintenance attempt limit is exhausted.');
    this.#busy = true;
    try {
      const candidate = { ...this.machine.view.current, pins: hashes(revision) };
      const begun = await this.#move({ event: 'switch', candidate, baseline, authorized, reason: 'administrator maintenance command' }); if (!begun.ok) return begun;
      return await this.#upgrade(revision);
    } catch { return await this.#rollback('The kernel maintenance operation failed.'); }
    finally { this.#busy = false; }
  }
  async #upgrade(revision: Revision): Promise<Result<void>> {
    const clients = await this.#live.process.clients(); if (!clients.ok) return this.#rollback(clients.error.message);
    const paused = await this.#live.process.call('pause'); if (!paused.ok) return this.#rollback(paused.error.message);
    const frozen = await this.#live.process.freeze(true); if (!frozen.ok) return this.#rollback(frozen.error.message);
    const drained = await this.#move({ event: 'drained', active: 0, reason: 'kernel admissions drained and writers stopped' }); if (!drained.ok) return this.#rollback(drained.error.message);
    const n = this.machine.view.current.n + 1; const attempt = `${String(n)}-${randomUUID()}`; this.#attempt = join(this.#config.root, 'runs', attempt); this.#captured = join(this.#config.root, `snapshot-${attempt}`);
    const captured = await this.#config.capture(this.#live.prepared.state, this.#captured); if (!captured.ok) return this.#rollback(captured.error.message);
    const saved = await this.#move({ event: 'snapshot', snapshot: captured.value, snapshotVerified: true, reason: 'stopped kernel store exported' }); if (!saved.ok) return this.#rollback(saved.error.message);
    const prepared = await prepare(this.#attempt, this.#captured, revision, this.#config.capture); if (!prepared.ok) return this.#rollback(prepared.error.message);
    const applied = await this.#move({ event: 'applied', pinsVerified: true, migrationsPassed: true, formatValid: true, reason: 'kernel pins and private store verified' }); if (!applied.ok) return this.#rollback(applied.error.message);
    const launched = await launch(this.#config, prepared.value, 'probe'); if (!launched.ok) return this.#rollback(launched.error.message);
    this.#next = { prepared: prepared.value, process: launched.value, revision: pinned(revision, prepared.value) };
    for (const major of new Set([this.#config.currentMajor, ...clients.value])) {
      const compatible = await probe(prepared.value.endpoint, major, this.#config.schemas, this.#config.clock); if (!compatible.ok) return this.#rollback(compatible.error.message);
    }
    const healthy = await this.#move({ event: 'healthy', probed: true, clientCompatible: true, reason: 'private kernel health and actual client majors accepted' }); if (!healthy.ok) return this.#rollback(healthy.error.message);
    this.#stopped = true; const stopped = await this.#live.process.stop(); if (!stopped.ok) return this.#rollback(stopped.error.message);
    const activated = await launched.value.call('activate'); if (!activated.ok) return this.#rollback(activated.error.message);
    const pointed = await this.#endpoint.repoint(prepared.value.endpoint); if (!pointed.ok) return this.#rollback(pointed.error.message);
    const committed = await this.#move({ event: 'repointed', atomic: true, stop: true, reason: 'kernel endpoint atomically promoted' }); if (!committed.ok) return this.#rollback(committed.error.message);
    this.#live = this.#next; this.#next = undefined; this.#stopped = false; return { ok: true, value: undefined };
  }
  async #rollback(reason: string): Promise<Result<void>> {
    const moved = await this.#move(this.machine.view.state === 'QUIESCING' ? { event: 'restart', reason, authorized: true, candidate: this.machine.view.current } : { event: 'failed', reason }); if (!moved.ok) return moved;
    if (this.#next) { const stopped = await this.#next.process.stop(); if (!stopped.ok) return this.#failed(stopped.error.message); this.#next = undefined; }
    if (this.#stopped) {
      if (!this.#captured) return this.#failed('The stopped kernel recovery snapshot is absent.');
      const prepared = await prepare(join(this.#config.root, 'runs', `recovery-${randomUUID()}`), this.#captured, this.#live.revision, this.#config.capture); if (!prepared.ok) return this.#failed(prepared.error.message);
      const restored = await launch(this.#config, prepared.value, 'serve'); if (!restored.ok) return this.#failed(restored.error.message);
      this.#live = { ...this.#live, prepared: prepared.value, process: restored.value }; const pointed = await this.#endpoint.repoint(this.#live.prepared.endpoint); if (!pointed.ok) return this.#failed(pointed.error.message);
    } else {
      const resumed = await this.#live.process.freeze(false); if (!resumed.ok) return this.#failed(resumed.error.message);
      const serving = await this.#live.process.call('resume'); if (!serving.ok) return this.#failed(serving.error.message);
    }
    const healthy = await probe(this.endpoint, this.#config.currentMajor, this.#config.schemas, this.#config.clock); if (!healthy.ok) return this.#failed(healthy.error.message);
    if (this.#attempt) await rm(this.#attempt, { recursive: true, force: true });
    if (this.#captured) await rm(this.#captured, { recursive: true, force: true });
    this.#attempt = undefined; this.#captured = undefined;
    const restored = await this.#move({ event: 'restored', restored: true, probed: true, reason: 'old kernel keeps serving' }); this.#stopped = false;
    return restored.ok ? failure('unsupported', reason) : restored;
  }
  async #failed(reason: string): Promise<Result<void>> { const failed = await this.#move({ event: 'failed', reason }); return failed.ok ? failure('io', reason) : failed; }
  async #move(input: Input): Promise<Result<void>> { const moved = await this.machine.transition(input); return moved.ok ? { ok: true, value: undefined } : moved; }
  close(): Promise<Result<void>> { return this.#live.process.stop(); }
}

function hashes(revision: Revision): Record<string, string> { return Object.fromEntries(Object.entries(revision.pins).map(([name, pin]) => [name, pin.hash])); }
function pinned(revision: Revision, prepared: Prepared): Revision { return { ...revision, pins: Object.fromEntries(Object.entries(revision.pins).map(([name, pin]) => [name, { ...pin, source: join(prepared.root, 'code', name) }])) }; }
async function launch(config: Configuration, prepared: Prepared, mode: 'probe' | 'serve'): Promise<Result<KernelProcess>> {
  const descriptors = await config.descriptors?.(); if (descriptors && !descriptors.ok) return descriptors;
  return KernelProcess.start({ ...prepared, configuration: prepared.configuration, administrator: config.administrator, mode, ...(descriptors?.ok ? { descriptors: descriptors.value } : {}) }, config.schemas, config.clock);
}
