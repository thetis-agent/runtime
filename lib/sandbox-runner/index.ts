/** Start every unprivileged process behind mandatory namespaces and resource controls; ADR 0005, ADR 0012. */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { realpath, statfs } from 'node:fs/promises';
import { resolve, isAbsolute, dirname } from 'node:path';
import { namespace, seal } from './namespace.ts';
import { Cgroup, resourceLimits } from './cgroup.ts';
import { failure } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';
import { gap } from '../semver-match/index.ts';

export interface Mount { source: string; path: string; mode: 'ro' | 'rw'; maximumBytes?: number }
export interface Plan {
  name: string; version: string; entry: string; args: readonly string[]; cwd: string;
  mounts: readonly Mount[]; socket: Socket; token: string;
}
export const limits = { ...resourceLimits, temporaryBytes: 32 * 1024 * 1024, mounts: 64, tokenBytes: 256 };
export interface Exit { code: number | null; signal: NodeJS.Signals | null }
export interface Running { process: ChildProcess; exited: Promise<Exit>; events(): Promise<Result<Record<string, number>, 'io'>>; stop(): Promise<Result<void, 'io'>>; dispose(): Promise<Result<void, 'io'>> }

async function argumentsFor(plan: Plan, runtime: string): Promise<Result<string[], 'outside-roots' | 'gap'>> {
  const args: string[] = [];
  if (plan.mounts.length > limits.mounts || !isAbsolute(plan.entry) || !isAbsolute(plan.cwd)) return failure('outside-roots', 'The sandbox mount plan is invalid.');
  try {
    args.push(...namespace(await realpath(runtime), limits.temporaryBytes), '--disable-userns');
    for (const mount of plan.mounts) {
      const path = resolve('/', mount.path);
      if (!isAbsolute(mount.path) || path === '/' || ['/proc', '/dev', '/runtime', '/usr', '/lib', '/lib64', '/bin', '/tmp'].some(root => path === root || path.startsWith(`${root}/`))) return failure('outside-roots', 'The mount would replace a reserved sandbox path.');
      const source = await realpath(mount.source);
      const fs = await statfs(source, { bigint: true });
      if (source === '/' || [0x63677270n, 0x9fa0n, 0x62656572n].includes(fs.type)) return failure('outside-roots', 'Host control filesystems cannot enter the sandbox.');
      if (mount.mode === 'rw') {
        if (!mount.maximumBytes || !Number.isSafeInteger(mount.maximumBytes) || mount.maximumBytes < 1 || fs.blocks * fs.bsize > BigInt(mount.maximumBytes)) return failure('gap', gap(plan, 'cap/storage.quota', '*'));
      }
      args.push(mount.mode === 'rw' ? '--bind' : '--ro-bind', source, path);
    }
    args.push('--remount-ro', '/proc', ...seal, '--chdir', plan.cwd, '--', '/runtime/bin/node', plan.entry, ...plan.args);
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

  async start(plan: Plan): Promise<Result<Running, 'outside-roots' | 'gap' | 'budget' | 'io' | 'auth'>> {
    if (!plan.token || Buffer.byteLength(plan.token) > limits.tokenBytes || plan.socket.destroyed) return failure('auth', 'The sandbox requires live inherited authority descriptors.');
    const args = await argumentsFor(plan, this.#runtime); if (!args.ok) return args;
    const group = await Cgroup.create(this.#cgroup); if (!group.ok) return failure('gap', gap(plan, 'cap/cgroup.v2', '*'));
    const child = spawn('/bin/sh', ['-c', 'IFS= read -r ready <&5 || exit 1; exec 5<&-; exec /usr/bin/bwrap "$@"', 'thetis-boundary', ...args.value], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe', plan.socket, 'pipe', 'pipe'] });
    const done = exited(child); const token = child.stdio.at(4); const gate = child.stdio.at(5);
    if (!child.pid || !(token instanceof Writable) || !(gate instanceof Writable) || !(await group.value.attach(child.pid)).ok) {
      child.kill('SIGKILL'); await done; const removed = await group.value.remove();
      return removed.ok ? failure('io', 'The sandbox could not enter its resource boundary.') : removed;
    }
    token.once('error', () => { child.kill('SIGKILL'); }); gate.once('error', () => { child.kill('SIGKILL'); });
    token.end(plan.token); gate.end('start\n');
    let disposed: Promise<Result<void, 'io'>> | undefined;
    const dispose = () => { disposed ??= done.then(() => group.value.remove()); return disposed; };
    return { ok: true, value: { process: child, exited: done, dispose, events: () => group.value.events(), async stop() {
      const killed = await group.value.kill(); if (!killed.ok) return killed;
      await done; return dispose();
    } } };
  }
}
