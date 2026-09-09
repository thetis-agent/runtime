/** Apply resource controls before releasing a sandboxed process; ADR 0005 §4, ADR 0012 §8. */
import { mkdir, readFile, writeFile, rmdir, readdir, realpath, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { failure } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';
import { clock } from '../events/index.ts';
import { state } from './freezer.ts';

export const resourceLimits = { memoryBytes: 128 * 1024 * 1024, processes: 64, cpuPercent: 100, runs: 256 };
export class Cgroup {
  readonly path: string;
  private constructor(path: string) { this.path = path; }

  static async create(root: string, limits = resourceLimits): Promise<Result<Cgroup, 'budget' | 'io'>> {
    if (![limits.memoryBytes, limits.processes, limits.cpuPercent, limits.runs].every(value => Number.isSafeInteger(value) && value > 0)) return failure('budget', 'The sandbox resource limits are invalid.');
    let path: string | undefined;
    try {
      const canonical = await realpath(root);
      if ((await statfs(canonical)).type !== 0x63677270) return failure('io', 'The delegated root is not a cgroup v2 filesystem.');
      const controllers = (await readFile(join(canonical, 'cgroup.subtree_control'), 'utf8')).trim().split(/\s+/u);
      if (!['cpu', 'memory', 'pids'].every(name => controllers.includes(name))) return failure('io', 'The delegated cgroup lacks cpu, memory or pids controls.');
      if ((await readdir(canonical)).filter(name => name.startsWith('run-')).length >= limits.runs) return failure('budget', 'The sandbox process pool is full.');
      path = join(canonical, `run-${randomUUID()}`); await mkdir(path);
      for (const [name, value] of Object.entries({ 'memory.max': String(limits.memoryBytes), 'memory.swap.max': '0', 'pids.max': String(limits.processes), 'cpu.max': `${String(limits.cpuPercent * 1000)} 100000` })) await writeFile(join(path, name), value);
      return { ok: true, value: new Cgroup(path) };
    } catch {
      if (path) try { await rmdir(path); } catch { return failure('io', 'The incomplete sandbox cgroup could not be removed.'); }
      return failure('io', 'The sandbox cgroup could not be created.');
    }
  }

  async attach(pid: number): Promise<Result<void, 'io'>> {
    try { await writeFile(join(this.path, 'cgroup.procs'), String(pid)); return { ok: true, value: undefined }; }
    catch { return failure('io', 'The sandbox process could not enter its cgroup.'); }
  }

  async kill(): Promise<Result<void, 'io'>> {
    try { await writeFile(join(this.path, 'cgroup.kill'), '1'); return { ok: true, value: undefined }; }
    catch { return failure('io', 'The sandbox process group could not be killed.'); }
  }

  async remove(): Promise<Result<void, 'io'>> {
    const empty = await state(this.path, 'populated', 0, clock); if (!empty.ok) return failure('io', empty.error.message);
    try { await rmdir(this.path); return { ok: true, value: undefined }; }
    catch { return failure('io', 'The sandbox cgroup still contains a process or cannot be removed.'); }
  }

  async events(): Promise<Result<Record<string, number>, 'io'>> {
    try {
      const text = await readFile(join(this.path, 'memory.events'), 'utf8');
      const values: Record<string, number> = {};
      for (const line of text.trim().split('\n')) {
        const [name, value] = line.split(/\s+/u);
        if (!name || value === undefined || !Number.isSafeInteger(Number(value))) return failure('io', 'The sandbox resource events are invalid.');
        values[name] = Number(value);
      }
      return { ok: true, value: values };
    } catch { return failure('io', 'The sandbox resource events could not be read.'); }
  }
}

export async function delegate(): Promise<Result<string, 'io'>> {
  try {
    const line = (await readFile('/proc/self/cgroup', 'utf8')).split('\n').find(line => line.startsWith('0::'));
    if (!line) return failure('io', 'The process has no cgroup v2 delegation.');
    const root = await realpath(`/sys/fs/cgroup${line.slice(3)}`);
    const processes = (await readFile(join(root, 'cgroup.procs'), 'utf8')).trim().split('\n').filter(Boolean);
    if (!/\/run-[^/]+\.scope$/u.test(root) || processes.length !== 1 || processes[0] !== String(process.pid)) return failure('io', 'The supervisor requires its own newly delegated scope.');
    const leaf = join(root, 'supervisor'); await mkdir(leaf, { recursive: true });
    for (const pid of processes) await writeFile(join(leaf, 'cgroup.procs'), pid);
    await writeFile(join(root, 'cgroup.subtree_control'), '+cpu +memory +pids');
    return { ok: true, value: root };
  } catch { return failure('io', 'The supervisor requires a delegated cgroup v2 scope.'); }
}
