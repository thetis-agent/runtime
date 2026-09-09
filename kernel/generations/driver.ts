/** Orchestrate real effects exclusively through the generation transition function; GN-001–006, ADR 0023–0025. */
import { join } from 'node:path';
import { lstat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Process } from '../boundary/process.ts';
import type { Context } from '../boundary/process.ts';
import type { Principal } from '../identity/index.ts';
import { Generations, deadlines } from './index.ts';
import type { Generation, Input } from './index.ts';
import { prepare, discard, serving } from './prepare.ts';
import type { Prepared, Revision } from './prepare.ts';
import { SnapshotStore } from '../../lib/snapshots/store.ts';
import { Endpoint } from '../../lib/socket/endpoint.ts';
import { failure } from '../../lib/schema/index.ts';
import { isObject } from '../../lib/schema/index.ts';
import type { Result } from '../../lib/schema/index.ts';
import type { Method } from '../../contracts/kernel-socket/types.ts';

interface Live { process: Process; prepared: Prepared; revision: Revision }
export interface Configuration { root: string; owner: string; context: Context }
export const limits = { connectionPollMs: 100 };

export class Driver {
  readonly machine: Generations;
  readonly #config: Configuration;
  readonly #store: SnapshotStore;
  readonly #endpoint: Endpoint;
  #live: Live;
  #previous: Revision | undefined;
  #next: Live | undefined;
  #stagedToken: string | undefined;
  #oldKilled = false;
  #busy = false;
  #writes: string[] = [];
  #interrupted: string[] = [];
  constructor(config: Configuration, machine: Generations, store: SnapshotStore, endpoint: Endpoint, live: Live) {
    this.#config = config; this.machine = machine; this.#store = store; this.#endpoint = endpoint; this.#live = live;
  }

  static async start(config: Configuration, revision: Revision, source: string, initial: Generation): Promise<Result<Driver>> {
    if (Object.keys(initial.pins).length !== Object.keys(revision.pins).length || Object.entries(revision.pins).some(([name, pin]) => initial.pins[name] !== pin.hash)) return failure('invalid-args', 'The initial generation does not match its pinned revision.');
    const store = new SnapshotStore(join(config.root, 'snapshots')); const state = await store.capture(source); if (!state.ok) return state;
    const endpoint = await Endpoint.open(join(config.root, 'runs')); if (!endpoint.ok) return endpoint;
    const token = config.context.identity.issue({ id: `${config.context.target}:${String(initial.n)}`, person: config.owner, scope: 'person', target: config.context.target, generation: initial.n, services: [] }); if (!token.ok) return token;
    const root = join(config.root, 'runs', `${String(initial.n)}-initial-${randomUUID()}`);
    const prepared = await prepare(root, revision, state.value, store, token.value, config.context);
    if (!prepared.ok) return abandon(config.context, token.value, root, prepared);
    const started = await Process.start(serving(prepared.value, revision), token.value, config.context); if (!started.ok) return abandon(config.context, token.value, root, started);
    const probe = await started.value.probe();
    const pointed = probe.ok ? await endpoint.value.repoint(prepared.value.endpoint) : probe;
    if (!pointed.ok) { const stopped = await started.value.stop('initial probe failed'); return stopped.ok ? abandon(config.context, token.value, root, pointed) : stopped; }
    const machine = new Generations(config.context.target, { ...initial, stateSnapshot: state.value }, config.context.journal, () => config.context.clock.now());
    return { ok: true, value: new Driver(config, machine, store, endpoint.value, { process: started.value, prepared: prepared.value, revision: { ...revision, pins: prepared.value.pins } }) };
  }

  get endpoint(): string { return this.#endpoint.path; }
  get state(): string { return this.#live.prepared.state; }
  get process(): Process { return this.#live.process; }

  invoke(method: Method, params: Record<string, unknown>): Promise<Result<unknown>> {
    return this.#busy || !this.machine.admits ? Promise.resolve(failure('switching', 'The target is switching and cannot admit a request.')) : this.#live.process.invoke(method, params);
  }

  async switch(revision: Revision, baseline: number, person: Principal): Promise<Result<void>> {
    if (this.#busy) return failure('switching', 'The target is already switching.');
    this.#busy = true;
    try { return await this.#switch(revision, baseline, person); } finally { this.#busy = false; }
  }

  async #switch(revision: Revision, baseline: number, person: Principal): Promise<Result<void>> {
    const candidate: Generation = { ...this.machine.view.current, pins: Object.fromEntries(Object.entries(revision.pins).map(([name, pin]) => [name, pin.hash])) };
    const begun = await this.#move({ event: 'switch', reason: 'requested', candidate, baseline, authorized: person.id === this.#config.owner || person.role === 'admin' }); if (!begun.ok) return begun;
    return this.#change(revision);
  }

  async undo(person: Principal): Promise<Result<void>> {
    if (this.#busy) return failure('switching', 'The target is already switching.');
    if (!this.#previous) return failure('invalid-args', 'No previous generation is retained.');
    this.#busy = true;
    try {
      const begun = await this.#move({ event: 'undo', reason: 'undo requested', authorized: person.id === this.#config.owner || person.role === 'admin' }); if (!begun.ok) return begun;
      return await this.#change(this.#previous, true);
    } finally { this.#busy = false; }
  }

  async #change(revision: Revision, undo = false): Promise<Result<void>> {
    this.#oldKilled = false; this.#writes = []; this.#interrupted = [];
    const drained = await this.#live.process.drain(deadlines.drain); if (!drained.ok) return drained;
    this.#oldKilled = drained.value.killed;
    this.#interrupted = drained.value.conversations;
    if (!this.#oldKilled) { const frozen = await this.#live.process.running.freeze(true, this.#config.context.clock); if (!frozen.ok) return frozen; }
    const frozen = await this.#move({ event: 'drained', reason: this.#oldKilled ? 'killed-for-switch' : 'turns drained', active: 0 }); if (!frozen.ok) return frozen;
    const captured = await this.#store.capture(this.state); if (!captured.ok) return this.#rollback(captured.error.message);
    const recorded = await this.#move({ event: 'snapshot', reason: 'verified state', snapshot: captured.value, snapshotVerified: true }); if (!recorded.ok) return this.#rollback(recorded.error.message);
    const next = this.machine.view.candidate; if (!next) throw new Error('A switching generation lost its candidate.');
    if (undo) { const audit = await this.#audit(next.stateSnapshot, captured.value, 'undo'); if (!audit.ok) return this.#rollback(audit.error.message); }
    const staged = this.#config.context.identity.stage({ id: `${this.#config.context.target}:${String(next.n)}`, person: this.#config.owner, scope: 'person', target: this.#config.context.target, generation: next.n, services: [] }); if (!staged.ok) return this.#rollback(staged.error.message);
    this.#stagedToken = staged.value;
    const prepared = await prepare(join(this.#config.root, 'runs', String(next.n)), undo ? { ...revision, migrations: [] } : revision, undo ? next.stateSnapshot : captured.value, this.#store, staged.value, this.#config.context);
    if (!prepared.ok) return this.#rollback(prepared.error.message);
    const applied = await this.#move({ event: 'applied', reason: 'pins, migrations and format verified', pinsVerified: true, migrationsPassed: true, formatValid: true }); if (!applied.ok) return this.#rollback(applied.error.message);
    const started = await Process.start(prepared.value.plan, staged.value, this.#config.context); if (!started.ok) return this.#rollback(started.error.message);
    this.#next = { process: started.value, prepared: prepared.value, revision: { ...revision, pins: prepared.value.pins } };
    const probed = await started.value.probe(); if (!probed.ok) return this.#rollback(probed.error.message);
    try { if (!(await lstat(prepared.value.endpoint)).isSocket()) return await this.#rollback('The private endpoint is not a socket.'); }
    catch { return this.#rollback('The private endpoint does not exist.'); }
    const healthy = await this.#move({ event: 'healthy', reason: 'private health answered', probed: true, clientCompatible: true }); if (!healthy.ok) return this.#rollback(healthy.error.message);
    this.#config.context.identity.fence(this.#config.context.target, next.n);
    const promoted = await this.#promote(next.n); if (!promoted.ok) return this.#rollback(promoted.error.message);
    const switched = await this.#finishSwitch(revision.migrate); if (!switched.ok) return this.#rollback(switched.error.message);
    this.#previous = this.#live.revision; this.#live = this.#next; this.#next = undefined; this.#stagedToken = undefined;
    const announced = await this.#announce();
    return announced.ok ? { ok: true, value: undefined } : failure('io', 'The generation committed but its update notice could not be delivered.');
  }

  async #promote(n: number): Promise<Result<void>> {
    const next = this.#next; if (!next) throw new Error('A commitment lost its private probe.');
    const stopped = await next.process.stop('promoting writable grants'); if (!stopped.ok) return stopped;
    try { await unlink(next.prepared.endpoint); } catch { return failure('io', 'The private probe endpoint could not be retired.'); }
    const token = this.#config.context.identity.issue({ id: `${this.#config.context.target}:${String(n)}:serving`, person: this.#config.owner, scope: 'person', target: this.#config.context.target, generation: n, services: [] }); if (!token.ok) return token;
    const started = await Process.start(serving(next.prepared, next.revision), token.value, this.#config.context); if (!started.ok) return started;
    this.#next = { ...next, process: started.value };
    const probed = await started.value.probe(); if (!probed.ok) return probed;
    return this.#endpoint.repoint(next.prepared.endpoint);
  }

  async #finishSwitch(mode: Revision['migrate']): Promise<Result<void>> {
    if (mode === 'stop') {
      const stopped = await this.#live.process.stop('generation switched'); if (!stopped.ok) return stopped;
      return this.#move({ event: 'repointed', reason: 'atomic endpoint rename', atomic: true, stop: true });
    }
    const moved = await this.#move({ event: 'repointed', reason: 'atomic endpoint rename', atomic: true }); if (!moved.ok) return moved;
    if (!this.#oldKilled) { const resumed = await this.#live.process.running.freeze(false, this.#config.context.clock); if (!resumed.ok) return resumed; }
    const since = this.#config.context.clock.now();
    while (!this.#oldKilled && this.#config.context.clock.now() - since < deadlines.oldDrain) {
      const status = await this.#live.process.control.call('health.probe', {}); if (!status.ok) return status;
      if (isObject(status.value) && status.value['connections'] === 0) break;
      await this.#config.context.clock.wait(limits.connectionPollMs);
    }
    const stopped = await this.#live.process.stop('old connection drain ended'); if (!stopped.ok) return stopped;
    return this.#move({ event: 'closed', reason: 'old connections closed or stopped', connections: 0 });
  }

  async #rollback(reason: string): Promise<Result<void>> {
    const rolled = await this.#move({ event: 'failed', reason }); if (!rolled.ok) return rolled;
    if (this.#next) { const stopped = await this.#next.process.stop('candidate refused'); if (!stopped.ok) return this.#failed(stopped.error.message); }
    if (this.#next && this.machine.view.committed) {
      const state = await this.#store.capture(this.#next.prepared.state); if (!state.ok) return this.#failed(state.error.message);
      const audited = await this.#audit(this.machine.view.current.stateSnapshot, state.value, 'rollback'); if (!audited.ok) return this.#failed(audited.error.message);
    } else this.#writes = [];
    if (this.#stagedToken) this.#config.context.identity.revoke(this.#stagedToken);
    this.#next = undefined; this.#stagedToken = undefined;
    const candidate = this.machine.view.candidate;
    if (candidate) { const removed = await discard(join(this.#config.root, 'runs', String(candidate.n))); if (!removed.ok) return this.#failed(removed.error.message); }
    if (this.machine.view.committed || this.#oldKilled) return this.#recover(reason);
    const resumed = await this.#live.process.running.freeze(false, this.#config.context.clock); if (!resumed.ok) return this.#failed(resumed.error.message);
    const probe = await this.#live.process.probe(); if (!probe.ok) return this.#failed(probe.error.message);
    const resumedNotice = await this.#announce(); if (!resumedNotice.ok) return this.#failed(resumedNotice.error.message);
    const restored = await this.#move({ event: 'restored', reason, restored: true, probed: true });
    return restored.ok ? failure('io', reason) : restored;
  }

  async #recover(reason: string): Promise<Result<void>> {
    const view = this.machine.view; const n = view.committed ? Math.max(view.current.n, view.candidate?.n ?? 0) + 1 : view.current.n;
    const stopped = await this.#live.process.stop('restoring snapshot'); if (!stopped.ok) return this.#failed(stopped.error.message);
    if (view.committed) this.#config.context.identity.fence(this.#config.context.target, n);
    const token = this.#config.context.identity.issue({ id: `${this.#config.context.target}:${String(n)}:recovery`, person: this.#config.owner, scope: 'person', target: this.#config.context.target, generation: n, services: [] }); if (!token.ok) return this.#failed(token.error.message);
    const root = join(this.#config.root, 'runs', `${String(n)}-recovery-${randomUUID()}`);
    const restored = await prepare(root, { ...this.#live.revision, migrations: [] }, view.current.stateSnapshot, this.#store, token.value, this.#config.context);
    if (!restored.ok) { const cleaned = await abandon(this.#config.context, token.value, root, restored); return this.#failed(cleaned.error.message); }
    const started = await Process.start(serving(restored.value, this.#live.revision), token.value, this.#config.context);
    if (!started.ok) { const cleaned = await abandon(this.#config.context, token.value, root, started); return this.#failed(cleaned.error.message); }
    this.#next = { process: started.value, prepared: restored.value, revision: { ...this.#live.revision, pins: restored.value.pins } };
    const probed = await started.value.probe(); if (!probed.ok) return this.#failed(probed.error.message);
    const pointed = await this.#endpoint.repoint(restored.value.endpoint); if (!pointed.ok) return this.#failed(pointed.error.message);
    const moved = await this.#move({ event: 'restored', reason, restored: true, probed: true }); if (!moved.ok) return this.#failed(moved.error.message);
    this.#live = this.#next; this.#next = undefined;
    const announced = await this.#announce(); return announced.ok ? failure('io', reason) : announced;
  }

  async #failed(reason: string): Promise<Result<void>> {
    const stopped = await this.#live.process.stop('recovery failed');
    const next = this.#next ? await this.#next.process.stop('recovery failed') : { ok: true };
    const recorded = await this.#move({ event: 'failed', reason });
    return !stopped.ok ? stopped : !next.ok ? failure('io', 'The recovery process could not be stopped.') : recorded.ok ? failure('io', reason) : recorded;
  }

  async #move(input: Input): Promise<Result<void>> {
    const result = await this.machine.transition(input); return result.ok ? { ok: true, value: undefined } : result;
  }

  async #audit(before: string, after: string, action: string): Promise<Result<void>> {
    const changes = await this.#store.changed(before, after); if (!changes.ok) return changes;
    this.#writes = changes.value;
    return this.#config.context.journal.observed(this.#config.context.target, 'generation.writes', { action, paths: changes.value }, true);
  }

  #announce(): Promise<Result<void>> {
    return this.#live.process.control.notify({ note: 'env.updated', params: { generation: this.machine.view.current.n, resume: true, writes: this.#writes, interrupted: this.#interrupted } });
  }
}

async function abandon(context: Context, token: string, root: string, refused: { ok: false; error: { code: string; message: string } }): Promise<{ ok: false; error: { code: string; message: string } }> {
  context.identity.revoke(token);
  const removed = await discard(root); return removed.ok ? refused : removed;
}
