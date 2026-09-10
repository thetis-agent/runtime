/** Serve the trusted kernel only through its own generation transaction and admit maintenance only for an administrator the kernel itself resolved; ADR 0048, ADR 0012 §6, GN-007. */
import { chmod, mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileHandle } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { Schemas, failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import { clock } from '@/lib/events/index.ts';
import { configuration } from '@/lib/deployment/index.ts';
import type { Configuration } from '@/lib/deployment/index.ts';
import { exclusive } from '@/lib/deployment/exclusive.ts';
import { exportDeployment } from '@/lib/deployment/store-export.ts';
import { delegate } from '@/lib/sandbox-runner/cgroup.ts';
import { Service } from '@/lib/service/lifecycle.ts';
import { socketFrames, send } from '@/lib/ndjson/socket.ts';
import type { Generation, Generations } from '@/kernel/generations/index.ts';
import type { Journal } from '@/kernel/log/index.ts';
import { Maintenance } from './index.ts';
import { kernelRevision } from './pins.ts';
import schema from './schema.json' with { type: 'json' };
import type { Control } from './types.ts';

// A target endpoint costs 76 bytes after the kernel root and a generation store name costs up to 13, against the 107-byte unix limit (ADR 0050).
export const supervisorLimits = { commandBytes: 65536, commands: 256, stateRootBytes: 18 };
export const supervisorService = { connections: 4, probeMs: 10000, exchangeMs: 600000, drainMs: 30000 };
// The supervised child advertises this one client major (kernel/maintenance-main.ts), so the probe must ask for it.
const kernelMajor = '1';

/** The generation machine and the journal stay kernel authority; the supervisor receives them rather than importing them (AGENTS.md kernel rules). */
export interface Authority {
  machine: new (target: string, initial: Generation, journal: Journal, now: () => number) => Generations;
  journal: { open(path: string, now: () => number): Promise<Result<Journal, 'io'>> };
}
export interface Arguments { seed: string; release: string; state?: string; credential?: string; delegated: boolean }
export interface Roots { state: string; supervisor: string; stores: string; control: string }

export function roots(args: Arguments, root: string): Result<Roots> {
  const state = args.state ?? dirname(root); const stores = join(state, 'g');
  return Buffer.byteLength(stores) > supervisorLimits.stateRootBytes
    ? failure('invalid-args', `A supervised state root longer than ${String(supervisorLimits.stateRootBytes)} bytes pushes a target endpoint past the Linux socket path limit.`)
    : { ok: true, value: { state, supervisor: join(state, 'supervisor'), stores, control: join(state, 'supervisor.sock') } };
}

export function parse(argv: readonly string[]): Result<Arguments> {
  const flags = new Map<string, string>(); const positional: string[] = []; let delegated = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? '';
    if (argument === '--delegate') { delegated = true; continue; }
    if (!argument.startsWith('--')) { positional.push(argument); continue; }
    const value = argv[++index];
    if (!['--release', '--state', '--credential'].includes(argument) || value === undefined) return failure('invalid-args', `The supervisor does not accept ${argument}.`);
    flags.set(argument, value);
  }
  const seed = positional[0];
  if (!seed || positional.length > 1) return failure('invalid-args', 'The supervisor requires exactly one deployment configuration path.');
  const release = flags.get('--release') ?? dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  return { ok: true, value: { seed, release, delegated, ...flags.has('--state') ? { state: flags.get('--state') ?? '' } : {}, ...flags.has('--credential') ? { credential: flags.get('--credential') ?? '' } : {} } };
}

/** A descriptor's offset advances after the kernel reads its 32 bytes, so every launch reopens the credential (ADR 0048). */
function credentials(path: string): { next(): Promise<Result<readonly number[]>>; close(): Promise<void> } {
  let held: FileHandle | undefined;
  const release = async (): Promise<void> => { const previous = held; held = undefined; if (previous) await previous.close().catch(() => undefined); };
  return {
    async next(): Promise<Result<readonly number[]>> {
      await release();
      try { held = await open(path, 'r'); return { ok: true, value: [held.fd] }; }
      catch { return failure('io', 'The kernel master key credential could not be opened.'); }
    },
    close: release,
  };
}

class ControlEndpoint {
  readonly #maintenance: Maintenance; readonly #schemas: Schemas; readonly #configuration: Configuration;
  readonly #service: Service; readonly ended = Promise.withResolvers<undefined>();
  #releases: { current: string; previous?: string }; #commands = 0;
  constructor(maintenance: Maintenance, schemas: Schemas, config: Configuration, current: string) {
    this.#maintenance = maintenance; this.#schemas = schemas; this.#configuration = config;
    this.#service = new Service(clock, supervisorService, 'io'); this.#releases = { current };
  }
  async open(path: string): Promise<Result<void>> {
    const opened = await this.#service.open(path, connection => this.#serve(connection.socket, connection.admitted), result => { if (!result.ok) process.stderr.write(`${JSON.stringify(result)}\n`); });
    if (!opened.ok) return opened;
    try { await chmod(path, 0o600); } catch { return failure('io', 'The supervisor control socket could not be restricted to its owner.'); }
    return { ok: true, value: undefined };
  }
  close(): Promise<Result<void>> { return this.#service.stop(); }
  async #serve(socket: Socket, admitted: () => void): Promise<Result<void>> {
    const check = this.#schemas.compile<Control>({ ...schema, $id: 'thetis://internal/maintenance/control', $ref: '#/$defs/control' });
    admitted();
    for await (const row of socketFrames(socket)) {
      if (!row.ok) return row;
      if (++this.#commands > supervisorLimits.commands) return failure('budget', 'The supervisor control command pool is exhausted.');
      if (!check(row.value) || Buffer.byteLength(JSON.stringify(row.value)) > supervisorLimits.commandBytes) return failure('invalid-args', 'The supervisor control command is invalid.');
      const command = row.value; const result = await this.#execute(command);
      const sent = await send(socket, { id: command.id, ...result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error } });
      if (!sent.ok) return sent;
      if (command.method === 'stop') { this.ended.resolve(undefined); return { ok: true, value: undefined }; }
    }
    return { ok: true, value: undefined };
  }
  async #execute(command: Control): Promise<Result<unknown>> {
    switch (command.method) {
      case 'status': return { ok: true, value: { view: this.#maintenance.machine.view, release: this.#releases.current, previous: this.#releases.previous ?? null, endpoint: this.#maintenance.endpoint, state: this.#maintenance.state } };
      case 'update': return this.#apply(command, command.release);
      case 'undo': return this.#apply(command, this.#releases.previous);
      case 'stop': return { ok: true, value: undefined };
    }
  }
  async #apply(command: Control, release: string | undefined): Promise<Result<void>> {
    if (release === undefined) return failure('invalid-args', 'The supervisor holds no previous release to undo to.');
    if (command.session === undefined || command.baseline === undefined) return failure('invalid-args', 'A supervisor update requires an administrator session and the baseline it was prepared against.');
    const caller = await this.#maintenance.whois(command.session); if (!caller.ok) return caller;
    if (caller.value.role !== 'admin') return failure('forbidden', 'Kernel maintenance requires an administrator.');
    const revision = await kernelRevision(release, this.#configuration, this.#schemas); if (!revision.ok) return revision;
    const applied = await this.#maintenance.upgrade(revision.value, command.baseline, true); if (!applied.ok) return applied;
    this.#releases = { current: release, previous: this.#releases.current };
    return { ok: true, value: undefined };
  }
}

async function serve(args: Arguments, config: Configuration, administrator: string, schemas: Schemas, authority: Authority): Promise<Result<void>> {
  if (args.delegated) { const delegated = await delegate(config.cgroup); if (!delegated.ok) return delegated; }
  const places = roots(args, config.root); if (!places.ok) return places;
  const { supervisor, stores, control } = places.value;
  await mkdir(supervisor, { recursive: true, mode: 0o700 }); await mkdir(stores, { recursive: true, mode: 0o700 });
  const journal = await authority.journal.open(join(supervisor, 'observed.jsonl'), () => Date.now()); if (!journal.ok) return journal;
  const keys = args.credential === undefined ? undefined : credentials(args.credential);
  const started = await start(args, config, administrator, schemas, authority, { root: supervisor, stores, journal: journal.value, keys });
  if (!started.ok) { await journal.value.close(); await keys?.close(); return started; }
  const endpoint = new ControlEndpoint(started.value, schemas, config, args.release);
  const opened = await endpoint.open(control);
  if (opened.ok) {
    process.stdout.write(`${JSON.stringify({ ok: true, value: { ready: true, endpoint: started.value.endpoint, control } })}\n`);
    await Promise.race([endpoint.ended.promise, terminated()]);
  }
  const drained = await endpoint.close(); const stopped = await started.value.close();
  await journal.value.close(); await keys?.close();
  return !opened.ok ? opened : !stopped.ok ? stopped : drained;
}

interface Held { root: string; stores: string; journal: Journal; keys: { next(): Promise<Result<readonly number[]>> } | undefined }

async function start(args: Arguments, config: Configuration, administrator: string, schemas: Schemas, authority: Authority, held: Held): Promise<Result<Maintenance>> {
  const revision = await kernelRevision(args.release, config, schemas); if (!revision.ok) return revision;
  const keys = held.keys;
  return Maintenance.start({
    root: held.root, stateRoot: held.stores, schemas, clock, administrator, currentMajor: kernelMajor, capture: exportDeployment,
    machine: initial => new authority.machine('kernel', initial, held.journal, () => Date.now()),
    ...keys ? { descriptors: () => keys.next() } : {},
  }, revision.value, config.root);
}

function terminated(): Promise<void> {
  return new Promise<void>(resolve => {
    const stop = (): void => { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); resolve(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  });
}

export async function supervise(argv: readonly string[], authority: Authority): Promise<Result<void>> {
  const args = parse(argv); if (!args.ok) return args;
  const schemas = new Schemas(); await schemas.load();
  const config = await configuration(args.value.seed, schemas); if (!config.ok) return config;
  const trusted = config.value.trusted;
  const administrator = trusted?.administrator ?? config.value.identity.people.find(person => person.role === 'admin')?.id;
  if (administrator === undefined) return failure('invalid-args', 'A supervised deployment names an administrator in its trusted block or its identity.');
  if (trusted && (trusted.keyFd !== 4 || args.value.credential === undefined)) return failure('invalid-args', 'A supervised trusted kernel reads its master key from a reopened credential on descriptor 4, after the maintenance control channel.');
  const lock = await exclusive(config.value.root, clock); if (!lock.ok) return lock;
  const served = await serve(args.value, config.value, administrator, schemas, authority);
  const released = await lock.value.close();
  return served.ok ? released : served;
}
