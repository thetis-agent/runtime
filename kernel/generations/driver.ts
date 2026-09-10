/** Orchestrate real effects exclusively through the generation transition function; GN-001–006, ADR 0023–0025. */
import { join } from 'node:path';
import { lstat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Process } from '@/kernel/boundary/process.ts';
import type { Context } from '@/kernel/boundary/process.ts';
import type { Principal, Run } from '@/kernel/identity/index.ts';
import { Generations, deadlines } from '@/kernel/generations/index.ts';
import type { Generation, Input, View } from '@/kernel/generations/index.ts';
import { prepare, discard, serving, limits as preparationLimits } from '@/kernel/generations/prepare.ts';
import type { Prepared, Revision } from '@/kernel/generations/prepare.ts';
import { SnapshotStore } from '@/lib/snapshots/store.ts';
import { retireRuns } from '@/lib/snapshots/retention.ts';
import { formats } from '@/lib/files/formats.ts';
import { Endpoint } from '@/lib/socket/endpoint.ts';
import { failure } from '@/lib/schema/index.ts';
import { isObject } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import type { Method } from '@/contracts/kernel-socket/types.ts';

interface Live { process: Process; prepared: Prepared; revision: Revision }
export interface Configuration { root: string; owner: string; context: Context; scope?: Run['scope']; services?: readonly string[]; cost?: number; recovered?: View; recoverySnapshot?: string; checkpoint?(view: View, prepared: Prepared, revision: Revision): Promise<Result<void>> }
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
  #pending: Revision | undefined;
  #oldKilled = false;
  #busy = false;
  #idle: ReturnType<typeof Promise.withResolvers<undefined>> | undefined;
  #observed: Promise<Result<void>>;
  #writes: string[] = [];
  #interrupted: string[] = [];
  constructor(config: Configuration, machine: Generations, store: SnapshotStore, endpoint: Endpoint, live: Live) {
    this.#config = config; this.machine = machine; this.#store = store; this.#endpoint = endpoint; this.#live = live;
    this.#observed = this.#supervise(live.process);
  }

  static async start(config: Configuration, revision: Revision, source: string, initial: Generation): Promise<Result<Driver>> {
    if (Object.keys(initial.pins).length !== Object.keys(revision.pins).length || Object.entries(revision.pins).some(([name, pin]) => initial.pins[name] !== pin.hash)) return failure('invalid-args', 'The initial generation does not match its pinned revision.');
    const store = new SnapshotStore(join(config.root, 'snapshots'));
    const state: Result<string> = config.recoverySnapshot ? { ok: true, value: config.recoverySnapshot } : config.recovered && config.recovered.state !== 'LIVE' ? { ok: true, value: config.recovered.current.stateSnapshot } : await store.capture(source); if (!state.ok) return state;
    const retired = await retireRuns(join(config.root, 'runs'), [source, ...revision.mounts.map(mount => mount.source)]); if (!retired.ok) return retired;
    const machine = new Generations(config.context.target, { ...initial, stateSnapshot: state.value }, config.context.journal, () => config.context.clock.now(), deadlines, config.recovered);
    if (config.recovered) {
      const moved = await machine.transition({ event: 'restart', reason: 'supervisor recovery', authorized: true, candidate: initial, snapshot: state.value }); if (!moved.ok) return moved;
      initial = { ...initial, n: Math.max(initial.n, config.recovered.candidate?.n ?? 0) + 1 };
      config.context.identity.fence(config.context.target, initial.n);
    }
    const endpoint = await Endpoint.open(join(config.root, 'runs')); if (!endpoint.ok) return endpoint;
    const token = config.context.identity.issue(principal(config, initial.n)); if (!token.ok) return token;
    const root = join(config.root, 'runs', `${String(initial.n)}-initial-${randomUUID()}`);
    const prepared = await prepare(root, config.recovered ? { ...revision, migrations: [] } : revision, state.value, store, token.value, config.context);
    if (!prepared.ok) return abandon(config.context, token.value, root, prepared);
    const started = await Process.start(serving(prepared.value, revision), token.value, config.context); if (!started.ok) return abandon(config.context, token.value, root, started);
    const probe = await started.value.probe();
    const healthy = probe.ok ? await initialSnapshot(started.value, prepared.value, revision, config.context, store) : probe;
    const view = { state: 'LIVE', current: { ...initial, stateSnapshot: healthy.ok ? healthy.value : state.value }, since: config.context.clock.now() };
    const active = config.recovered ? machine : new Generations(config.context.target, view.current, config.context.journal, () => config.context.clock.now());
    const observed = !healthy.ok ? healthy : config.recovered ? await active.transition({ event: 'restored', reason: 'recovered pins and state probed', snapshot: healthy.value, restored: true, probed: true }) : await config.context.journal.observed(config.context.target, 'generation.initial', { snapshot: view }, true);
    const saved = observed.ok ? await config.checkpoint?.(active.view, prepared.value, revision) ?? { ok: true, value: undefined } : observed;
    const resumed = saved.ok ? await started.value.running.freeze(false, config.context.clock) : saved;
    const pointed = resumed.ok ? await endpoint.value.repoint(prepared.value.endpoint) : resumed;
    if (!pointed.ok) { const stopped = await started.value.stop('initial probe failed'); return stopped.ok ? abandon(config.context, token.value, root, pointed) : stopped; }
    const driver = new Driver(config, active, store, endpoint.value, { process: started.value, prepared: prepared.value, revision: { ...revision, pins: prepared.value.pins } });
    const cleaned = await driver.#retire(); if (!cleaned.ok) { const stopped = await started.value.stop('initial retention failed'); return stopped.ok ? cleaned : stopped; }
    return { ok: true, value: driver };
  }

  get pins(): Revision['pins'] { return this.#live.revision.pins; }
  get endpoint(): string { return this.#endpoint.path; }
  get state(): string { return this.#live.prepared.state; }
  get process(): Process { return this.#live.process; }
  get admits(): boolean { return !this.#busy && this.machine.admits && this.process.alive; }
  get exited(): Promise<Result<void>> { return this.#observed; }

  invoke(method: Method, params: Record<string, unknown>): Promise<Result<unknown>> {
    return !this.admits ? Promise.resolve(failure('switching', 'The target is switching and cannot admit a request.')) : this.#live.process.invoke(method, params);
  }

  async switch(revision: Revision, baseline: number, person: Principal): Promise<Result<void>> {
    if (this.#busy) return failure('switching', 'The target is already switching.');
    this.#lock();
    try { return await this.#switch(revision, baseline, person); } finally { this.#release(); }
  }

  async #switch(revision: Revision, baseline: number, person: Principal): Promise<Result<void>> {
    const begun = await this.#begin(revision, baseline, person); if (!begun.ok) return this.machine.view.state === 'QUIESCING' ? this.#rollback(begun.error.message) : begun;
    return this.#change(revision);
  }

  async quiesce(revision: Revision, baseline: number, person: Principal): Promise<Result<void>> {
    if (this.#busy) return failure('switching', 'The target is already switching.');
    this.#lock(); this.#pending = revision;
    const begun = await this.#begin(revision, baseline, person);
    const frozen = begun.ok ? await this.#freeze() : begun;
    if (frozen.ok) return frozen;
    try { return this.machine.view.state === 'LIVE' ? frozen : await this.#rollback(frozen.error.message); }
    finally { this.#release(); this.#pending = undefined; }
  }
  async stage(): Promise<Result<void>> {
    if (!this.#pending || !['FROZEN', 'APPLYING'].includes(this.machine.view.state)) return failure('switching', 'The target has no frozen default transaction.');
    return this.#prepare(this.#pending);
  }
  async commit(): Promise<Result<void>> {
    if (!this.#pending || !this.#next || this.machine.view.state !== 'SWITCHING') return failure('switching', 'The target has no probed default transaction.');
    try { return await this.#commit(this.#pending); } finally { this.#pending = undefined; this.#release(); }
  }
  async abort(reason: string): Promise<Result<void>> {
    try {
      if (this.machine.view.state !== 'LIVE') await this.#rollback(reason);
      return this.machine.admits ? { ok: true, value: undefined } : failure('io', 'The default target could not restore its prior generation.');
    } finally { this.#pending = undefined; this.#release(); }
  }
  #begin(revision: Revision, baseline: number, person: Principal): Promise<Result<void>> {
    const candidate: Generation = { ...this.machine.view.current, pins: Object.fromEntries(Object.entries(revision.pins).map(([name, pin]) => [name, pin.hash])) };
    return this.#move({ event: 'switch', reason: 'requested', candidate, baseline, authorized: person.id === this.#config.owner || person.role === 'admin' });
  }

  async reset(person: Principal): Promise<Result<void>> {
    if (this.#busy) return failure('switching', 'The target is already switching.');
    if (person.id !== this.#config.owner && person.role !== 'admin') return failure('forbidden', 'The reset requires the target owner or an administrator.');
    if (this.machine.view.state === 'LIVE' && !this.process.alive) { const failed = await this.#move({ event: 'crashed', reason: 'resetting an exited process', exited: true }); if (!failed.ok) return failed; }
    if (this.machine.view.state !== 'FAILED') return this.#previous ? this.undo(person) : this.switch(this.#live.revision, this.machine.view.current.n, person);
    this.#lock();
    try { return await this.#reset(); } finally { this.#release(); }
  }

  async #reset(): Promise<Result<void>> {
    const moved = await this.#move({ event: 'reset', reason: 'reset requested', candidate: this.machine.view.current, authorized: true });
    if (!moved.ok) return this.machine.view.state === 'ROLLING_BACK' ? this.#failed(moved.error.message) : moved;
    const restored = await this.#recover('reset requested');
    return this.machine.admits ? { ok: true, value: undefined } : restored;
  }

  async undo(person: Principal): Promise<Result<void>> {
    if (this.#busy) return failure('switching', 'The target is already switching.');
    if (!this.#previous) return failure('invalid-args', 'No previous generation is retained.');
    this.#lock();
    try {
      const begun = await this.#move({ event: 'undo', reason: 'undo requested', authorized: person.id === this.#config.owner || person.role === 'admin' }); if (!begun.ok) return this.machine.view.state === 'QUIESCING' ? await this.#rollback(begun.error.message) : begun;
      return await this.#change(this.#previous, true);
    } finally { this.#release(); }
  }

  async #change(revision: Revision, undo = false): Promise<Result<void>> {
    const frozen = await this.#freeze(); if (!frozen.ok) return this.#rollback(frozen.error.message);
    const prepared = await this.#prepare(revision, undo); return prepared.ok ? this.#commit(revision) : prepared;
  }

  async #freeze(): Promise<Result<void>> {
    this.#oldKilled = false; this.#writes = []; this.#interrupted = [];
    const drained = await this.#live.process.drain(deadlines.drain); if (!drained.ok) return drained;
    this.#oldKilled = drained.value.killed;
    this.#interrupted = drained.value.conversations;
    if (!this.#oldKilled) { const frozen = await this.#live.process.running.freeze(true, this.#config.context.clock); if (!frozen.ok) return frozen; }
    const frozen = await this.#move({ event: 'drained', reason: this.#oldKilled ? 'killed-for-switch' : 'turns drained', active: 0 }); if (!frozen.ok) return frozen;
    return { ok: true, value: undefined };
  }

  async capture(): Promise<Result<string>> {
    if (this.machine.view.state !== 'FROZEN') return failure('switching', 'Only a frozen generation can be captured.');
    const captured = await this.#store.capture(this.state); if (!captured.ok) return captured;
    const recorded = await this.#move({ event: 'snapshot', reason: 'verified state', snapshot: captured.value, snapshotVerified: true });
    return recorded.ok ? captured : recorded;
  }

  async #prepare(revision: Revision, undo = false): Promise<Result<void>> {
    const captured: Result<string> = this.machine.view.state === 'FROZEN' ? await this.capture() : { ok: true, value: this.machine.view.current.stateSnapshot };
    if (!captured.ok) return this.#rollback(captured.error.message);
    const next = this.machine.view.candidate; if (!next) throw new Error('A switching generation lost its candidate.');
    if (undo) { const audit = await this.#audit(next.stateSnapshot, captured.value, 'undo'); if (!audit.ok) return this.#rollback(audit.error.message); }
    const staged = this.#config.context.identity.stage(principal(this.#config, next.n)); if (!staged.ok) return this.#rollback(staged.error.message);
    this.#stagedToken = staged.value;
    const prepared = await prepare(join(this.#config.root, 'runs', String(next.n)), undo ? { ...revision, migrations: [] } : revision, undo ? next.stateSnapshot : captured.value, this.#store, staged.value, this.#config.context, this.#live.prepared.pins);
    if (!prepared.ok) return this.#rollback(prepared.error.message);
    const applied = await this.#move({ event: 'applied', reason: 'pins, migrations and format verified', pinsVerified: true, migrationsPassed: true, formatValid: true }); if (!applied.ok) return this.#rollback(applied.error.message);
    const started = await Process.start(prepared.value.plan, staged.value, this.#config.context); if (!started.ok) return this.#rollback(started.error.message);
    this.#next = { process: started.value, prepared: prepared.value, revision: { ...revision, pins: prepared.value.pins } };
    const probed = await started.value.probe(); if (!probed.ok) return this.#rollback(probed.error.message);
    try { if (!(await lstat(prepared.value.endpoint)).isSocket()) return await this.#rollback('The private endpoint is not a socket.'); }
    catch { return this.#rollback('The private endpoint does not exist.'); }
    const stopped = await started.value.stop('private probe complete'); if (!stopped.ok) return this.#rollback(stopped.error.message);
    const valid = await formats(prepared.value.state, revision.formats, this.#config.context.schemas, preparationLimits.formatBytes); if (!valid.ok) return this.#rollback(valid.error.message);
    const state = await this.#store.capture(prepared.value.state); if (!state.ok) return this.#rollback(state.error.message);
    const healthy = await this.#move({ event: 'healthy', reason: 'private health answered', snapshot: state.value, probed: true, clientCompatible: true }); if (!healthy.ok) return this.#rollback(healthy.error.message);
    return { ok: true, value: undefined };
  }

  async #commit(revision: Revision): Promise<Result<void>> {
    const next = this.machine.view.candidate; if (!next || !this.#next) throw new Error('A commitment lost its candidate.');
    this.#config.context.identity.fence(this.#config.context.target, next.n);
    if (revision.migrate === 'stop') { const retired = await this.#retireOld(); if (!retired.ok) return this.#rollback(retired.error.message); }
    const promoted = await this.#promote(next.n); if (!promoted.ok) return this.#rollback(promoted.error.message);
    const switched = await this.#finishSwitch(revision.migrate); if (!switched.ok && this.machine.view.state !== 'LIVE') return this.#rollback(switched.error.message);
    this.#adopt(true);
    if (!switched.ok) return this.#failed(switched.error.message);
    const announced = await this.#announce();
    const cleaned = await this.#retire();
    return !cleaned.ok ? cleaned : announced.ok ? { ok: true, value: undefined } : failure('io', 'The generation committed but its update notice could not be delivered.');
  }

  async #retireOld(): Promise<Result<void>> {
    if (this.#oldKilled || !this.#live.process.alive) { this.#oldKilled = true; return { ok: true, value: undefined }; }
    const resumed = await this.#live.process.running.freeze(false, this.#config.context.clock); if (!resumed.ok) return resumed;
    const stopped = await this.#live.process.shutdown('generation switched', deadlines.drain); if (!stopped.ok) return stopped;
    this.#oldKilled = true;
    const captured = await this.#store.capture(this.state); if (!captured.ok) return captured;
    return this.#audit(this.machine.view.current.stateSnapshot, captured.value, 'shutdown');
  }

  async #promote(n: number): Promise<Result<void>> {
    const next = this.#next; if (!next) throw new Error('A commitment lost its private probe.');
    const stopped = await next.process.stop('promoting writable grants'); if (!stopped.ok) return stopped;
    try { await unlink(next.prepared.endpoint); }
    catch (error) { if (!isObject(error) || error['code'] !== 'ENOENT') return failure('io', 'The private probe endpoint could not be retired.'); }
    const token = this.#config.context.identity.issue(principal(this.#config, n)); if (!token.ok) return token;
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
    this.#oldKilled ||= !this.#live.process.alive;
    if (!this.#oldKilled) { const resumed = await this.#live.process.running.freeze(false, this.#config.context.clock); if (!resumed.ok) return resumed; }
    const since = this.#config.context.clock.now();
    while (!this.#oldKilled && this.#config.context.clock.now() - since < deadlines.oldDrain) {
      const status = await this.#live.process.control.call('health.probe', {}); if (!status.ok) return status;
      if (isObject(status.value) && status.value['connections'] === 0) break;
      await this.#config.context.clock.wait(limits.connectionPollMs);
    }
    const stopped = await this.#live.process.shutdown('old connection drain ended', deadlines.drain); if (!stopped.ok) return stopped;
    return this.#move({ event: 'closed', reason: 'old connections closed or stopped', connections: 0 });
  }

  async #rollback(reason: string): Promise<Result<void>> {
    const rolled = this.machine.view.state === 'QUIESCING' ? await this.#interrupt(reason) : await this.#move({ event: 'failed', reason });
    if (!rolled.ok && this.machine.view.state !== 'ROLLING_BACK') return rolled;
    if (this.#next) { const stopped = await this.#next.process.stop('candidate refused'); if (!stopped.ok) return this.#failed(stopped.error.message); }
    if (this.#next && this.machine.view.committed) {
      const state = await this.#store.capture(this.#next.prepared.state); if (!state.ok) return this.#failed(state.error.message);
      const audited = await this.#audit(this.machine.view.current.stateSnapshot, state.value, 'rollback'); if (!audited.ok) return this.#failed(audited.error.message);
    } else this.#writes = [];
    if (this.#stagedToken) this.#config.context.identity.revoke(this.#stagedToken);
    this.#next = undefined; this.#stagedToken = undefined;
    const candidate = this.machine.view.candidate;
    if (candidate) { const removed = await discard(join(this.#config.root, 'runs', String(candidate.n))); if (!removed.ok) return this.#failed(removed.error.message); }
    if (this.machine.view.committed || this.#oldKilled || !this.#live.process.alive) return this.#recover(reason);
    const resumed = await this.#live.process.running.freeze(false, this.#config.context.clock); if (!resumed.ok) return this.#failed(resumed.error.message);
    const probe = await this.#live.process.probe(); if (!probe.ok) return this.#failed(probe.error.message);
    const resumedNotice = await this.#announce(); if (!resumedNotice.ok) return this.#failed(resumedNotice.error.message);
    const restored = await this.#move({ event: 'restored', reason, restored: true, probed: true });
    if (!restored.ok) return this.#failed(restored.error.message);
    const cleaned = await this.#retire(); return cleaned.ok ? failure('io', reason) : cleaned;
  }

  async #interrupt(reason: string): Promise<Result<void>> {
    const drained = await this.#live.process.drain(deadlines.drain);
    if (drained.ok) this.#interrupted = [...new Set([...this.#interrupted, ...drained.value.conversations])];
    const stopped = await this.#live.process.stop('recovering interrupted quiesce'); this.#oldKilled = true;
    const valid = stopped.ok ? await formats(this.state, this.#live.revision.formats, this.#config.context.schemas, preparationLimits.formatBytes) : stopped;
    const snapshot = valid.ok ? await this.#store.capture(this.state) : valid;
    return this.#move({ event: 'restart', reason, authorized: true, candidate: this.machine.view.current, ...(snapshot.ok ? { snapshot: snapshot.value } : {}) });
  }

  async #recover(reason: string): Promise<Result<void>> {
    const view = this.machine.view; const n = view.committed ? Math.max(view.current.n, view.candidate?.n ?? 0) + 1 : view.current.n;
    const stopped = await this.#live.process.stop('restoring snapshot'); if (!stopped.ok) return this.#failed(stopped.error.message);
    const candidate = { ...view.current, n };
    if (view.committed) {
      const reserved = await this.#move({ event: 'recovering', reason, authorized: true, candidate }); if (!reserved.ok) return this.#failed(reserved.error.message);
      this.#config.context.identity.fence(this.#config.context.target, n);
    }
    const token = this.#config.context.identity.issue(principal(this.#config, n)); if (!token.ok) return this.#failed(token.error.message);
    const root = join(this.#config.root, 'runs', `${String(n)}-recovery-${randomUUID()}`);
    const restored = await prepare(root, { ...this.#live.revision, migrations: [] }, view.current.stateSnapshot, this.#store, token.value, this.#config.context, this.#live.prepared.pins);
    if (!restored.ok) { const cleaned = await abandon(this.#config.context, token.value, root, restored); return this.#failed(cleaned.error.message); }
    const started = await Process.start(serving(restored.value, this.#live.revision), token.value, this.#config.context);
    if (!started.ok) { const cleaned = await abandon(this.#config.context, token.value, root, started); return this.#failed(cleaned.error.message); }
    this.#next = { process: started.value, prepared: restored.value, revision: { ...this.#live.revision, pins: restored.value.pins } };
    const probed = await started.value.probe(); if (!probed.ok) return this.#failed(probed.error.message);
    const pointed = await this.#endpoint.repoint(restored.value.endpoint); if (!pointed.ok) return this.#failed(pointed.error.message);
    const moved = await this.#move({ event: 'restored', reason, restored: true, probed: true, ...(view.committed ? { candidate } : {}) });
    if (this.machine.view.state === 'LIVE') this.#adopt();
    if (!moved.ok) return this.#failed(moved.error.message);
    const announced = await this.#announce(); const cleaned = await this.#retire(); return !cleaned.ok ? cleaned : announced.ok ? failure('io', reason) : announced;
  }

  async #failed(reason: string): Promise<Result<void>> {
    const stopped = await this.#live.process.stop('recovery failed');
    const next = this.#next ? await this.#next.process.stop('recovery failed') : { ok: true };
    const recorded = await this.#move(this.machine.view.state === 'LIVE' ? { event: 'crashed', reason, exited: true } : { event: 'failed', reason });
    return !stopped.ok ? stopped : !next.ok ? failure('io', 'The recovery process could not be stopped.') : recorded.ok ? failure('io', reason) : recorded;
  }

  async #move(input: Input): Promise<Result<void>> {
    const result = await this.machine.transition(input); if (!result.ok) return result;
    const view = this.machine.view;
    const live = this.#next && view.state === 'LIVE' ? this.#next : this.#live;
    return await this.#config.checkpoint?.(view, live.prepared, live.revision) ?? { ok: true, value: undefined };
  }

  async #audit(before: string, after: string, action: string): Promise<Result<void>> {
    const changes = await this.#store.changed(before, after); if (!changes.ok) return changes;
    this.#writes = changes.value;
    return this.#config.context.journal.observed(this.#config.context.target, 'generation.writes', { action, paths: changes.value }, true);
  }

  #announce(): Promise<Result<void>> {
    return this.#live.process.control.notify({ note: 'env.updated', params: { generation: this.machine.view.current.n, resume: true, writes: this.#writes, interrupted: this.#interrupted } });
  }

  #lock(): void { this.#busy = true; this.#idle = Promise.withResolvers<undefined>(); }
  #release(): void { this.#busy = false; this.#idle?.resolve(undefined); }
  #retire(): Promise<Result<void>> { return retireRuns(join(this.#config.root, 'runs'), [this.#live.prepared.root, ...this.#live.revision.mounts.map(mount => mount.source)]); }

  #adopt(previous = false): void {
    const next = this.#next; if (!next) throw new Error('A live generation lost its prepared process.');
    if (previous) this.#previous = this.#live.revision;
    this.#live = next; this.#next = undefined; this.#stagedToken = undefined;
    this.#observed = this.#supervise(next.process);
  }

  async #supervise(process: Process): Promise<Result<void>> {
    const ended = await process.exited;
    if (ended.expected) return ended.result;
    while (this.#busy) { if (!this.#idle) throw new Error('A generation transaction lost its completion barrier.'); await this.#idle.promise; }
    if (process !== this.#live.process || this.machine.view.state !== 'LIVE') return ended.result;
    this.#lock();
    try { return await this.#move({ event: 'crashed', reason: ended.result.ok ? 'unexpected process exit' : ended.result.error.message, exited: true }); }
    finally { this.#release(); }
  }
}

async function initialSnapshot(process: Process, prepared: Prepared, revision: Revision, context: Context, store: SnapshotStore): Promise<Result<string>> {
  const frozen = await process.running.freeze(true, context.clock); if (!frozen.ok) return frozen;
  const valid = await formats(prepared.state, revision.formats, context.schemas, preparationLimits.formatBytes); if (!valid.ok) return valid;
  return store.capture(prepared.state);
}

async function abandon(context: Context, token: string, root: string, refused: { ok: false; error: { code: string; message: string } }): Promise<{ ok: false; error: { code: string; message: string } }> {
  context.identity.revoke(token);
  const removed = await discard(root); return removed.ok ? refused : removed;
}

function principal(config: Configuration, generation: number): Omit<Run, 'expires'> {
  return { id: config.scope === 'deployment' ? config.context.target : `${config.context.target}:${String(generation)}`, person: config.owner, scope: config.scope ?? 'person', target: config.context.target, generation, services: config.services ?? [], ...(config.cost === undefined ? {} : { cost: config.cost }) };
}
