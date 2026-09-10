/** Assemble only verified targets and route scoped control through their generation machines; KS-004–009, KS-023, ADR 0019. */
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { transaction } from '../../lib/deployment/transaction.ts';
import type { Member, Phases } from '../../lib/deployment/transaction.ts';
import { Driver } from '../generations/driver.ts';
import { discard } from '../generations/prepare.ts';
import type { Revision } from '../generations/prepare.ts';
import type { Identity, Principal, Run } from '../identity/index.ts';
import type { Journal } from '../log/index.ts';
import type { Operation, Operations } from '../socket/index.ts';
import { Usage } from './usage.ts';
import type { Schemas, Result } from '../../lib/schema/index.ts';
import { failure, isObject } from '../../lib/schema/index.ts';
import type { Clock } from '../../lib/events/index.ts';
import type { SandboxRunner, Mount } from '../../lib/sandbox-runner/index.ts';
import type { Entry, Registration } from '../../lib/package-loader/types.ts';
import { validator } from '../../lib/package-loader/index.ts';
import type { Secrets } from '../secrets/index.ts';
import { declaration, deliver } from '../secrets/spawn.ts';
import { Register } from '../../lib/package-loader/registration.ts';
import { requirements } from '../../lib/package-loader/requirements.ts';
import type { Method } from '../../contracts/kernel-socket/types.ts';
import type { Socket } from 'node:net';
import type { Context } from './process.ts';
import { execution } from './execution.ts';
import { socketPair } from '../../lib/socket/pair.ts';
import { executionPlan } from '../../lib/deployment/execution-plan.ts';
import type { EvaluationBridge } from '../../lib/deployment/evaluation.ts';
import { Pins } from '../../lib/pins/index.ts';
import { sessionMethods } from '../../lib/socket/sessions.ts';
import { recovery } from '../../lib/deployment/recover.ts';
import type { Recovery } from '../../lib/deployment/recover.ts';
import { saveCheckpoint, neutralCheckpoint } from '../../lib/deployment/checkpoint.ts';

export function sessionWhois(identity: Identity, run: Run, token: unknown): Result<{ person: string; role: string }> {
  const resolved = typeof token === 'string' ? identity.resolveSession(token) : failure('auth', 'The session token is invalid.');
  if (!resolved.ok) return resolved;
  return run.scope === 'person' && resolved.value.id !== run.person ? failure('forbidden', 'The session names a different person than this run.') : { ok: true, value: { person: resolved.value.id, role: resolved.value.role } };
}

export interface Target {
  id: string; owner: string; scope: Run['scope']; revision: Revision; state: string;
  profile: Record<string, unknown>; entries: readonly Entry[]; services: readonly string[];
  registration?: { package: string; id: string; [key: string]: unknown };
  environment?: boolean;
}
export interface RuntimeContext { root: string; identity: Identity; journal: Journal; schemas: Schemas; clock: Clock; runner: SandboxRunner; recoveryJournal?: string; secrets?: Secrets; extension?(target: Target): { methods: ReadonlyMap<Method, Operation>; capabilities: readonly string[] } }
interface Mounted { target: Target; profiles: Map<number, Target>; driver?: Driver; failure?: string }
export const runtimeLimits = { targets: 64, profiles: 4 };

export class Runtime {
  readonly #context: RuntimeContext;
  readonly #targets = new Map<string, Mounted>();
  readonly #usage: Usage;
  readonly #pins: Pins;
  #defaultBusy = false;
  readonly #maintenance: Driver[] = [];
  readonly #transients = new Map<string, Driver>();
  constructor(context: RuntimeContext) { this.#context = context; this.#pins = new Pins(join(context.root, 'conversation-pins.json'), context.schemas); this.#usage = new Usage(context.identity, context.journal, () => context.clock.now()); }

  async start(target: Target, restored?: Recovery): Promise<Result<void>> {
    if (this.#targets.has(target.id) || this.#targets.size >= runtimeLimits.targets) return failure('budget', 'The target already exists or the runtime pool is full.');
    if (target.scope === 'person' && !this.#context.identity.principal(target.owner) || target.scope === 'deployment' && target.owner !== '') return failure('unbound', 'The target does not have a valid scoped principal.');
    const saved: Result<Recovery | undefined> = restored ? { ok: true, value: restored } : this.#context.recoveryJournal ? await recovery(join(this.#context.root, 'checkpoints'), this.#context.recoveryJournal, target.id, this.#context.schemas) : { ok: true, value: undefined };
    if (!saved.ok) return saved;
    if (saved.value) {
      if (saved.value.target.owner !== target.owner || saved.value.target.scope !== target.scope) return failure('forbidden', 'The recovered target does not match its configured principal.');
      target = saved.value.target;
    }
    const services = this.#services(target); if (!services.ok) return services;
    const allowed = this.#usage.allowMount(target.owner); if (!allowed.ok) return allowed;
    const revision = await this.#revision(target); if (!revision.ok) return revision;
    const initial = { ...(saved.value?.view.current ?? { n: 1, stateSnapshot: '', prefixRenderer: '1', at: this.#context.clock.now() }), pins: Object.fromEntries(Object.entries(target.revision.pins).map(([name, pin]) => [name, pin.hash])) };
    const epoch = saved.value ? Math.max(initial.n, saved.value.view.candidate?.n ?? 0) + 1 : initial.n;
    const mounted: Mounted = { target, profiles: new Map([[epoch, target]]) }; this.#targets.set(target.id, mounted);
    const context = { ...this.#context, target: target.id, operations: this.#operations(mounted) };
    const started = await Driver.start({ root: join(this.#context.root, createHash('sha256').update(target.id).digest('base64url')), owner: target.owner, scope: target.scope, services: services.value, context,
      ...(saved.value ? { recovered: saved.value.view } : {}),
      ...(restored ? { recoverySnapshot: restored.checkpoint.view.current.stateSnapshot } : {}),
      checkpoint: (view, prepared, revision) => saveCheckpoint(join(this.#context.root, 'checkpoints'), { version: 1, target: { ...(mounted.profiles.get(view.current.n) ?? mounted.target), revision }, pins: prepared.pins, view, state: prepared.state, endpoint: prepared.endpoint }, this.#context.schemas)
    }, revision.value, saved.value?.checkpoint.state ?? target.state, initial);
    if (!started.ok) { mounted.failure = started.error.message; return started; }
    mounted.driver = started.value; return { ok: true, value: undefined };
  }

  async transient(owner: string, services: readonly string[], ...[plan, setup, policy]: Parameters<EvaluationBridge['start']>): ReturnType<EvaluationBridge['start']> {
    if (this.#transients.size >= 8) return failure('budget', 'The transient generation pool is full.');
    const principal = this.#context.identity.principal(owner); if (!principal) return failure('unbound', 'The execution account has no ordinary principal.');
    const allowed = this.#usage.allowMount(owner); if (!allowed.ok) return allowed;
    const prepared = await executionPlan(plan, setup); if (!prepared.ok) return prepared;
    const target = randomUUID(); const grants = this.#services({ id: target, owner, scope: 'person', revision: prepared.value.revision, state: prepared.value.state, profile: setup, entries: setup.entries, services }); if (!grants.ok) return grants;
    const methods = new Map<Method, Operation>([['health.probe', () => Promise.resolve({ ok: true, value: { ready: true } })], ['profile.get', () => Promise.resolve({ ok: true, value: prepared.value.setup })]]);
    for (const method of sessionMethods) methods.set(method, () => Promise.resolve(failure('forbidden', 'An isolated execution cannot route its own upstream sessions.')));
    const context: Context = { ...this.#context, target, operations: { methods, notes: ['run.stop', 'env.updated', 'turn.report', 'notice'], note: (run: Run, note: { note: string; params: Record<string, unknown> }) => this.#context.journal.reported(run.target, note.note, note.params) } };
    const started = await execution(context, join(this.#context.root, 'transient'), owner, grants.value, policy.cost, prepared.value.revision, prepared.value.state);
    if (!started.ok) { this.#context.identity.retire(target); const cleaned = await discard(join(this.#context.root, 'transient', target)); return cleaned.ok ? started : cleaned; }
    const driver = started.value; this.#transients.set(target, driver);
    return { ok: true, value: { process: { probe: () => driver.process.probe(), invoke: (method, params) => driver.invoke(method, params), running: driver.process.running, stop: async reason => {
      return this.#retireTransient(target, driver, reason);
    } }, target, diagnostic: () => undefined } };
  }

  async emptyAuthority(): Promise<Result<{ socket: Socket; token: string; close(): Promise<Result<void>> }>> {
    const pair = await socketPair(); if (!pair.ok) return pair;
    const target = randomUUID(); const token = this.#context.identity.issue({ id: randomUUID(), target, person: '', scope: 'deployment', generation: 1, services: [], cost: 0 });
    if (!token.ok) { await pair.value.close(); return token; }
    return { ok: true, value: { socket: pair.value.client, token: token.value, close: async () => { this.#context.identity.retire(target); return pair.value.close(); } } };
  }

  status(person: Principal, target: string): Result<Record<string, unknown>> {
    const found = this.#targets.get(target); if (!found) return failure('not-found', 'The environment does not exist.');
    if (found.target.owner !== person.id && person.role !== 'admin' && !person.observeOthers) return failure('forbidden', 'The environment belongs to another person.');
    return { ok: true, value: { target, ready: found.driver?.admits ?? false, generation: found.driver?.machine.view.current.n ?? 0, state: found.driver?.machine.view.state ?? 'FAILED', ...(found.failure ? { reason: found.failure } : {}) } };
  }

  endpoint(target: string): Result<string> {
    const value = this.#targets.get(target)?.driver;
    return value ? { ok: true, value: value.endpoint } : failure('not-found', 'The target endpoint does not exist.');
  }

  current(target: string): Result<Target> {
    const mounted = this.#targets.get(target); return mounted?.driver ? { ok: true, value: structuredClone(mounted.target) } : failure('not-found', 'The target is unavailable.');
  }

  endpointDirectory(target: string): Result<string> {
    const endpoint = this.endpoint(target); return endpoint.ok ? { ok: true, value: dirname(endpoint.value) } : endpoint;
  }

  async session(person: Principal, method: Method, params: Record<string, unknown>): Promise<Result<unknown>> {
    if (this.#defaultBusy) return failure('switching', 'The default transaction is switching.');
    if (!sessionMethods.includes(method)) return Promise.resolve(failure('unsupported', 'This is not a session operation.'));
    const requested = method === 'session.list' && typeof params['person'] === 'string' ? params['person'] : person.id;
    if (requested !== person.id && !person.observeOthers) return Promise.resolve(failure('forbidden', 'The conversation list belongs to another person.'));
    const mounted = [...this.#targets.values()].find(value => value.target.scope === 'person' && value.target.owner === requested && value.target.environment !== false);
    const driver = mounted?.driver; if (!driver) return failure('not-found', 'The person has no running environment.');
    const hashes = Object.values(driver.machine.view.current.pins);
    if (method === 'session.create') return this.#pins.create(requested, hashes, () => driver.invoke(method, params));
    if (method === 'session.submit' && typeof params['conversation'] === 'string') {
      const pinned = await this.#pins.pin({ target: requested, conversation: params['conversation'], hashes }); if (!pinned.ok) return pinned;
    }
    return driver.invoke(method, params);
  }

  async maintenancePause(person: Principal): Promise<Result<void>> {
    if (person.role !== 'admin') return failure('forbidden', 'Kernel maintenance requires an administrator.');
    if (this.#defaultBusy) return failure('switching', 'A generation transaction is already active.');
    this.#defaultBusy = true;
    for (const mounted of [...this.#targets.values()].reverse()) {
      const driver = mounted.driver; if (!driver) continue;
      this.#maintenance.push(driver);
      const stopped = await driver.quiesce(mounted.target.revision, driver.machine.view.current.n, person);
      const captured = stopped.ok ? await driver.capture() : stopped;
      if (!captured.ok) { const restored = await this.maintenanceResume(person); return restored.ok ? captured : restored; }
    }
    return { ok: true, value: undefined };
  }

  async maintenanceResume(person: Principal): Promise<Result<void>> {
    if (person.role !== 'admin') return failure('forbidden', 'Kernel maintenance requires an administrator.');
    let refused: Result<void> | undefined;
    for (const driver of this.#maintenance.splice(0).reverse()) { const resumed = await driver.abort('kernel maintenance cancelled'); if (!resumed.ok) refused ??= resumed; }
    this.#defaultBusy = false; return refused ?? { ok: true, value: undefined };
  }

  async group(person: Principal, targets: readonly Target[], phases: Phases): Promise<Result<void>> {
    if (this.#defaultBusy) return failure('baseline-moved', 'The default baseline is being moved.');
    if (person.role !== 'admin') return failure('forbidden', 'The default target coordinator requires kernel authority.');
    const live = [...this.#targets.values()].filter(value => value.target.scope === 'deployment');
    if (targets.length !== live.length || new Set(targets.map(target => target.id)).size !== targets.length || targets.some(target => !live.some(value => value.target.id === target.id))) return failure('unsupported', 'The default release must name every existing deployment target exactly once.');
    const members: Member[] = [];
    for (const target of targets) {
      const found = this.#targets.get(target.id); if (!found?.driver) return failure('not-found', 'A default target is unavailable.');
      if (target.scope !== 'deployment' || target.owner !== '' || JSON.stringify(target.services) !== JSON.stringify(found.target.services)) return failure('unsupported', 'The default release cannot change an existing target scope or service grants.');
      const revision = await this.#revision(target); if (!revision.ok) return revision;
      members.push(this.#member(found, found.driver, target, revision.value, person));
    }
    this.#defaultBusy = true;
    try { return await transaction(members, phases); } finally {
      for (const found of live) for (const n of found.profiles.keys()) if (n < (found.driver?.machine.view.current.n ?? 1) - 1) found.profiles.delete(n);
      this.#defaultBusy = false;
    }
  }
  #member(found: Mounted, driver: Driver, target: Target, revision: Revision, person: Principal): Member {
    const old = found.target; const baseline = driver.machine.view.current.n;
    return { id: target.id,
      freeze: () => { found.profiles.set(baseline + 1, target); return driver.quiesce(revision, baseline, person); },
      capture: async () => {
        const captured = await driver.capture(); return captured.ok ? { ok: true, value: neutralCheckpoint({ version: 1, target: old, pins: driver.pins, view: driver.machine.view, state: driver.state, endpoint: driver.endpoint }) } : captured;
      }, stage: () => driver.stage(),
      commit: async () => { const result = await driver.commit(); if (['LIVE', 'FAILED'].includes(driver.machine.view.state) && driver.machine.view.current.n === baseline + 1) found.target = target; return result; },
      rollback: async reason => {
        const undo = driver.machine.view.state === 'LIVE' && driver.machine.view.current.n !== baseline && found.target === target;
        found.profiles.set(driver.machine.view.current.n + 1, old);
        const result = undo ? await driver.undo(person) : await driver.abort(reason);
        if (result.ok) { found.target = old; found.profiles.set(driver.machine.view.current.n, old); }
        return result;
      }
    };
  }
  async offer(digest: string, generation: number): Promise<Result<void>> {
    for (const found of this.#targets.values()) if (found.target.scope === 'person' && found.target.environment !== false && found.driver) {
      const sent = await found.driver.process.control.notify({ note: 'env.updated', params: { digest, generation, offered: true } }); if (!sent.ok) return sent;
    }
    return { ok: true, value: undefined };
  }

  prune<T>(hash: string, operation: () => Promise<Result<T>>): Promise<Result<T>> { return this.#pins.prune(hash, operation); }

  async switch(person: Principal, target: Target, baseline: number): Promise<Result<void>> {
    if (this.#defaultBusy) return failure('switching', 'The default transaction is switching.');
    const found = this.#targets.get(target.id); if (!found?.driver) return failure('not-found', 'The target does not exist.');
    if (target.owner !== found.target.owner || target.scope !== found.target.scope) return failure('forbidden', 'A switch cannot change the target principal.');
    if (baseline !== found.driver.machine.view.current.n) return failure('baseline-moved', 'The target baseline moved; prepare again.');
    found.profiles.set(baseline + 1, target);
    const revision = await this.#revision(target); if (!revision.ok) { found.profiles.delete(baseline + 1); return revision; }
    const switched = await found.driver.switch(revision.value, baseline, person);
    if (['LIVE', 'FAILED'].includes(found.driver.machine.view.state) && found.driver.machine.view.current.n === baseline + 1) found.target = target;
    else found.profiles.delete(baseline + 1);
    const current = found.driver.machine.view.current.n; found.profiles.set(current, found.target);
    for (const generation of found.profiles.keys()) if (generation < current - 1) found.profiles.delete(generation);
    return switched;
  }

  async reset(person: Principal, target: string): Promise<Result<void>> {
    if (this.#defaultBusy) return failure('switching', 'The default transaction is switching.');
    const found = this.#targets.get(target); if (!found) return failure('not-found', 'The environment does not exist.');
    if (found.target.owner !== person.id && person.role !== 'admin') return failure('forbidden', 'The environment belongs to another person.');
    if (!found.driver) { this.#targets.delete(target); return this.start(found.target); }
    const before = found.driver.machine.view;
    const prior = before.state === 'FAILED' ? found.target : found.profiles.get(before.current.n - 1) ?? found.target;
    found.profiles.set(before.current.n + 1, prior);
    const reset = await found.driver.reset(person);
    if (reset.ok) { const current = found.driver.machine.view.current; found.profiles.set(current.n, prior); found.target = prior; }
    return reset;
  }

  async close(): Promise<Result<void>> {
    let failure: Result<void> | undefined;
    for (const [target, driver] of this.#transients) { const cleaned = await this.#retireTransient(target, driver, 'runtime shutdown'); if (!cleaned.ok) failure ??= cleaned; }
    for (const mounted of [...this.#targets.values()].reverse()) {
      if (!mounted.driver) continue;
      const stopped = await mounted.driver.process.stop('runtime shutdown'); if (!stopped.ok) failure ??= stopped;
    }
    return failure ?? { ok: true, value: undefined };
  }

  async #retireTransient(target: string, driver: Driver, reason: string): Promise<Result<void>> {
    const stopped = await driver.process.stop(reason); if (!stopped.ok) return stopped;
    this.#context.identity.retire(target);
    const cleaned = await discard(join(this.#context.root, 'transient', target));
    if (cleaned.ok) this.#transients.delete(target);
    return cleaned;
  }

  async #revision(target: Target): Promise<Result<Revision>> {
    const mounts: Mount[] = [];
    for (const mount of target.revision.mounts) {
      if (!mount.source.startsWith('service:')) { mounts.push(mount); continue; }
      const name = mount.source.slice('service:'.length);
      if (!target.services.includes(name)) return failure('forbidden', 'The mount is absent from the recorded service grants.');
      const directory = this.endpointDirectory(name); if (!directory.ok) return directory;
      mounts.push({ ...mount, source: directory.value, mode: 'ro' });
    }
    const { name, version, entry, args, cwd, execution } = target.revision.plan;
    const plan = { name, version, entry, args, cwd, ...(execution ? { execution } : {}) };
    if (!target.registration?.['declared']) return { ok: true, value: { ...target.revision, plan, mounts } };
    const source = target.entries.find(entry => entry.manifest.name === target.registration?.package);
    if (!source) return failure('envelope', 'The spawn package is absent from the verified target.');
    const spawn = await declaration(source, target.registration, this.#context.schemas); if (!spawn.ok) return spawn;
    if (spawn.value.scope !== target.scope || spawn.value.cmd !== 'node' || spawn.value.args?.[0] !== entry || JSON.stringify(spawn.value.args.slice(1)) !== JSON.stringify(args)) return failure('envelope', 'The target command differs from its declared spawn.');
    const values = await deliver(this.#context.secrets, target.id, target.scope === 'person' ? `person/${target.owner}` : 'deployment', spawn.value, source.manifest); if (!values.ok) return values;
    return { ok: true, value: { ...target.revision, plan: { ...plan, network: spawn.value.network === 'egress' ? 'egress' : 'none', secrets: values.value }, mounts } };
  }

  #services(target: Target): Result<string[]> {
    const result: string[] = [];
    for (const name of target.services) {
      const service = this.#targets.get(name);
      if (!service?.driver || service.target.scope === 'person' && service.target.owner !== target.owner) return failure('forbidden', 'The target cannot mount an unavailable or differently scoped service.');
      result.push(service.target.scope === 'deployment' ? name : `${name}:${String(service.driver.machine.view.current.n)}`);
    }
    return { ok: true, value: result };
  }

  #operations(mounted: Mounted): Operations {
    const methods = new Map<Method, Operation>();
    for (const method of ['env.status', 'env.reset'] satisfies Method[]) methods.set(method, (run, params) => {
      const person = this.#context.identity.principal(run.person);
      if (!person) return Promise.resolve(failure('forbidden', 'The run has no environment authority.'));
      const target = typeof params['target'] === 'string' ? params['target'] : run.person;
      return method === 'env.status' ? Promise.resolve(this.status(person, target)) : this.reset(person, target);
    });
    methods.set('health.probe', () => Promise.resolve({ ok: true, value: { ready: true } }));
    for (const method of sessionMethods.filter(method => method !== 'session.subscribe')) methods.set(method, (run, params) => {
      const person = this.#context.identity.principal(run.person);
      return person && run.scope === 'person' ? this.session(person, method, params) : Promise.resolve(failure('forbidden', 'This run has no scoped session authority.'));
    });
    methods.set('profile.get', run => { const profile = (mounted.profiles.get(run.generation) ?? mounted.target).profile; return Promise.resolve({ ok: true, value: { ...profile, ...(isObject(profile['runtime']) ? { runtime: { ...profile['runtime'], generation: run.generation } } : {}) } }); });
    methods.set('package.register', (run, params) => this.#register(mounted, run, params));
    methods.set('token.whois', (run, params) => {
      const caller = typeof params['runToken'] === 'string' ? this.#context.identity.authenticate(params['runToken']) : failure('auth', 'The caller credential is invalid.');
      if (!caller.ok) return Promise.resolve(caller);
      return Promise.resolve(run.scope === 'deployment' || run.id === caller.value.id && run.person === caller.value.person && run.target === caller.value.target && run.generation === caller.value.generation ? caller : failure('forbidden', 'Only deployment scope can resolve another run.'));
    });
    methods.set('session.whois', (run, params) => Promise.resolve(sessionWhois(this.#context.identity, run, params['sessionToken'])));
    methods.set('usage.report', (run, params) => this.#report(run, params));
    methods.set('identity.assert', (run, params) => Promise.resolve(run.scope === 'deployment' && typeof params['kind'] === 'string' && typeof params['id'] === 'string' ? this.#context.identity.session(run.target, params['kind'], params['id']) : failure('forbidden', 'The identity assertion requires a designated deployment authority.')));
    const extension = this.#context.extension?.(mounted.target);
    for (const [method, handler] of extension?.methods ?? []) { if (methods.has(method)) throw new Error('An extension cannot replace kernel authority.'); methods.set(method, method === 'prune' ? (run, params) => typeof params['id'] === 'string' ? this.prune(params['id'], () => handler(run, params)) : Promise.resolve(failure('invalid-args', 'The prune identity is absent.')) : handler); }
    return { capabilities: extension?.capabilities ?? [], methods, notes: ['turn.report', 'notice', 'run.stop', 'env.updated'], note: (run, note) => note.note === 'turn.report' || note.note === 'notice' ? this.#context.journal.reported(run.target, note.note, note.params) : Promise.resolve(failure('forbidden', 'Only the kernel sends lifecycle control.')) };
  }

  async #register(mounted: Mounted, run: Run, params: Record<string, unknown>): Promise<Result<void>> {
    const target = mounted.profiles.get(run.generation); const entry = target?.entries.find(entry => entry.manifest.name === params['package']);
    if (!entry) return failure('envelope', 'The package is absent from the recorded profile envelope.');
    const check = await validator<Registration>(this.#context.schemas, 'registration');
    const registration = new Register(entry, check); const valid = registration.register(params); if (!valid.ok) return valid;
    const value = registration.finish(undefined); if (!value.ok) return value;
    if (!value.value || !target) return failure('invalid-args', 'The recorded registration is absent.');
    const matched = await requirements(target.entries, target.scope, target.profile, target.revision.pins, entry, value.value, this.#context.schemas); if (!matched.ok) return matched;
    for (const spawn of value.value.spawn ?? []) {
      const active = [...this.#targets.values()].find(value => target.services.includes(value.target.id) && value.target.registration?.package === entry.manifest.name && value.target.registration.id === spawn.id);
      if (!active?.driver || active.target.scope !== spawn.scope) return failure('gap', `${entry.manifest.name} ${entry.manifest.version} requires service/${spawn.id} *. Nothing in this profile provides it. No configured registry provides it.`);
      if (spawn.cmd !== 'node' || spawn.args?.[0] !== active.target.revision.plan.entry || JSON.stringify(spawn.args.slice(1)) !== JSON.stringify(active.target.revision.plan.args)) return failure('envelope', 'The active service does not match its recorded spawn declaration.');
    }
    target.profile['registrations'] = matched.value;
    return { ok: true, value: undefined };
  }

  #report(run: Run, params: Record<string, unknown>): Promise<Result<void>> {
    const { runToken, callId, counters } = params;
    if (typeof runToken !== 'string' || typeof callId !== 'string' || !isObject(counters) || typeof counters['cost'] !== 'number') return Promise.resolve(failure('invalid-args', 'The usage attribution fields are invalid.'));
    const values: Record<string, number> = {};
    for (const [name, value] of Object.entries(counters)) {
      if (typeof value !== 'number') return Promise.resolve(failure('invalid-args', 'The usage attribution fields are invalid.'));
      values[name] = value;
    }
    return this.#usage.report(run, { runToken, callId, counters: { ...values, cost: counters['cost'] } });
  }
}
