/** Start every unprivileged process behind mandatory namespaces and resource controls; ADR 0005, ADR 0012. */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { realpath, statfs } from 'node:fs/promises';
import { resolve, isAbsolute, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { namespace, seal } from './namespace.ts';
import { Cgroup, resourceLimits } from './cgroup.ts';
import { failure } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';
import { gap } from '../semver-match/index.ts';
import { freeze } from './freezer.ts';
import { egress, privateNetwork } from './network.ts';
import type { Network } from './network.ts';
import type { Clock } from '../events/index.ts';

export interface Mount { source: string; path: string; mode: 'ro' | 'rw'; maximumBytes?: number }
export interface Plan {
  name: string; version: string; entry: string; args: readonly string[]; cwd: string;
  mounts: readonly Mount[]; network?: 'none' | 'egress'; execution?: 'source' | 'artifacts'; socket: Socket; token: string; secrets?: Readonly<Record<string, string>>;
}
export const limits = { ...resourceLimits, heapMiB: 32, youngMiB: 1, temporaryBytes: 32 * 1024 * 1024, mounts: 64, tokenBytes: 256, secretBytes: 65536 };
export interface Exit { code: number | null; signal: NodeJS.Signals | null }
export interface Running {
  process: ChildProcess; exited: Promise<Exit>;
  freeze(frozen: boolean, clock: Clock): Promise<Result<void, 'io' | 'deadline'>>;
  events(): Promise<Result<Record<string, number>, 'io'>>;
  health(): Result<void, 'io'>;
  stop(): Promise<Result<void, 'io'>>; dispose(): Promise<Result<void, 'io'>>;
}

async function argumentsFor(plan: Plan, runtime: string): Promise<Result<string[], 'outside-roots' | 'gap'>> {
  const args: string[] = [];
  if (plan.mounts.length > limits.mounts || !isAbsolute(plan.entry) || !isAbsolute(plan.cwd)) return failure('outside-roots', 'The sandbox mount plan is invalid.');
  if (![undefined, 'source', 'artifacts'].includes(plan.execution)) return failure('outside-roots', 'The sandbox execution mode is invalid.');
  try {
    if (![undefined, 'none', 'egress'].includes(plan.network)) return failure('gap', gap(plan, 'cap/network.egress', '*'));
    const base = namespace(await realpath(runtime), limits.temporaryBytes);
    args.push(...(plan.network === 'egress' ? base.filter(argument => argument !== '--unshare-net') : base), '--disable-userns');
    if (plan.network === 'egress') args.push('--dir', '/etc', '--file', '9', '/etc/resolv.conf');
    for (const mount of plan.mounts) {
      const path = resolve('/', mount.path);
      if (!isAbsolute(mount.path) || path === '/' || ['/proc', '/dev', '/runtime', '/usr', '/lib', '/lib64', '/bin', '/tmp', '/thetis-bootstrap.ts', '/thetis-artifacts'].some(root => path === root || path.startsWith(`${root}/`))) return failure('outside-roots', 'The mount would replace a reserved sandbox path.');
      const source = await realpath(mount.source);
      const fs = await statfs(source, { bigint: true });
      if (source === '/' || [0x63677270n, 0x9fa0n, 0x62656572n].includes(fs.type)) return failure('outside-roots', 'Host control filesystems cannot enter the sandbox.');
      if (mount.mode === 'rw') {
        if (!mount.maximumBytes || !Number.isSafeInteger(mount.maximumBytes) || mount.maximumBytes < 1 || fs.blocks * fs.bsize > BigInt(mount.maximumBytes)) return failure('gap', gap(plan, 'cap/storage.quota', '*'));
      }
      args.push(mount.mode === 'rw' ? '--bind' : '--ro-bind', source, path);
    }
    const bootstrap = fileURLToPath(new URL('./bootstrap.ts', import.meta.url)); const flags: string[] = [];
    if (plan.execution === 'artifacts') {
      args.push('--ro-bind', fileURLToPath(new URL('../artifacts/', import.meta.url)), '/thetis-artifacts');
      for (const suffix of ['.js', '.artifact.json']) args.push('--ro-bind', `${bootstrap}${suffix}`, `/thetis-bootstrap.ts${suffix}`);
      flags.push('--no-experimental-strip-types', '--import', '/thetis-artifacts/register.mjs');
    }
    args.push('--setenv', 'NODE_COMPILE_CACHE', join(plan.cwd, '.node-compile-cache'), '--ro-bind', bootstrap, '/thetis-bootstrap.ts', '--remount-ro', '/proc', ...seal, '--chdir', plan.cwd, '--', '/runtime/bin/node', `--max-old-space-size=${String(limits.heapMiB)}`, `--max-semi-space-size=${String(limits.youngMiB)}`, ...flags, '/thetis-bootstrap.ts', plan.entry, ...plan.args);
    return { ok: true, value: args };
  } catch { return failure('outside-roots', 'The sandbox mount source could not be canonicalised.'); }
}

function exited(child: ChildProcess): Promise<Exit> {
  return new Promise(resolve => {
    child.once('error', () => { resolve({ code: null, signal: null }); });
    child.once('exit', (code, signal) => { resolve({ code, signal }); });
  });
}

export class SandboxRunner {
  readonly #cgroup: string;
  readonly #runtime: string;
  constructor(cgroup: string, runtime = dirname(dirname(process.execPath))) { this.#cgroup = cgroup; this.#runtime = runtime; }

  reap(): Promise<Result<number, 'io'>> { return Cgroup.reap(this.#cgroup); }

  async start(plan: Plan): Promise<Result<Running, 'outside-roots' | 'gap' | 'budget' | 'io' | 'auth'>> {
    if (!plan.token || Buffer.byteLength(plan.token) > limits.tokenBytes || plan.socket.destroyed) return failure('auth', 'The sandbox requires live inherited authority descriptors.');
    const secrets = JSON.stringify(plan.secrets ?? {});
    if (Buffer.byteLength(secrets) > limits.secretBytes) return failure('budget', 'The spawn secret delivery exceeds its byte limit.');
    const args = await argumentsFor(plan, this.#runtime); if (!args.ok) return args;
    const group = await Cgroup.create(this.#cgroup); if (!group.ok) return failure('gap', gap(plan, 'cap/cgroup.v2', '*'));
    plan.socket.pause();
    const command = `IFS= read -r ready <&5 || exit 1; exec 5<&-; ${plan.network === 'egress' ? privateNetwork : 'exec /usr/bin/bwrap "$@"'}`;
    const child = spawn('/bin/sh', ['-c', command, 'thetis-boundary', ...args.value], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe', plan.socket, 'pipe', 'pipe', 'pipe', ...(plan.network === 'egress' ? ['pipe', 'pipe', 'pipe'] satisfies ('pipe')[] : [])] });
    const done = exited(child); const token = child.stdio.at(4); const gate = child.stdio.at(5); const delivery = child.stdio.at(6);
    if (!child.pid || !(token instanceof Writable) || !(gate instanceof Writable) || !(delivery instanceof Writable) || !(await group.value.attach(child.pid)).ok) {
      child.kill('SIGKILL'); await done; const removed = await group.value.remove();
      return removed.ok ? failure('io', 'The sandbox could not enter its resource boundary.') : removed;
    }
    for (const descriptor of [token, gate, delivery]) descriptor.once('error', () => { if (!descriptor.writableFinished) child.kill('SIGKILL'); });
    token.end(plan.token); delivery.end(secrets); gate.end('start\n');
    plan.socket.destroy();
    let network: Network | undefined; let networkEnd: Promise<Result<void, 'io'>> | undefined;
    if (plan.network === 'egress') {
      const configured = await egress(child, group.value);
      if (!configured.ok) { const killed = await group.value.kill(); await done; const removed = await group.value.remove(); return !killed.ok ? killed : !removed.ok ? removed : failure('gap', gap(plan, 'cap/network.egress', '*')); }
      network = configured.value; networkEnd = done.then(() => configured.value.stop());
    }
    let disposed: Promise<Result<void, 'io'>> | undefined;
    const dispose = () => { disposed ??= done.then(async () => { const stopped = await networkEnd; const removed = await group.value.remove(); return stopped && !stopped.ok ? stopped : removed; }); return disposed; };
    return { ok: true, value: { process: child, exited: done, dispose, health: () => network?.health() ?? { ok: true, value: undefined }, freeze: (frozen, clock) => freeze(group.value.path, frozen, clock), events: () => group.value.events(), async stop() {
      const stopped = await network?.stop(); const killed = await group.value.kill(); if (!killed.ok) return killed;
      await done; const removed = await dispose(); return stopped && !stopped.ok ? stopped : removed;
    } } };
  }
}
