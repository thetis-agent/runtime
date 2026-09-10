/** Configure only a pre-created private namespace before releasing bubblewrap; ADR 0029. */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import type { Cgroup } from './cgroup.ts';
import { clock } from '@/lib/events/index.ts';
import type { Clock } from '@/lib/events/index.ts';
import { failure } from '@/lib/result/index.ts';
import type { Result } from '@/lib/result/index.ts';
export const networkLimits = { readyMs: 10000, outputBytes: 65536 };
export interface Network { stop(): Promise<Result<void, 'io'>>; health(): Result<void, 'io'> }
export const privateNetwork = 'exec /usr/bin/unshare --user --map-root-user --net /bin/sh -c \'printf 1 >&7; exec 7>&-; IFS= read -r ready <&8 || exit 1; exec 8<&-; exec /usr/bin/bwrap "$@"\' private-network "$@"';

async function ready(stream: Readable, child: ChildProcess, time: Clock): Promise<Result<void, 'io'>> {
  const timer = new AbortController();
  const outcome = Promise.withResolvers<Result<void, 'io'>>();
  const received = (bytes: Buffer): void => { outcome.resolve(bytes.length === 1 && bytes[0] === 49 ? { ok: true, value: undefined } : failure('io', 'The network helper emitted an invalid readiness frame.')); };
  const closed = (): void => { outcome.resolve(failure('io', 'The network helper closed before readiness.')); };
  stream.once('data', received); stream.once('end', closed); stream.once('error', closed); child.once('exit', closed);
  const deadline = time.wait(networkLimits.readyMs, timer.signal).then(() => { if (!timer.signal.aborted) outcome.resolve(failure('io', 'The network helper exceeded its readiness deadline.')); });
  try { return await outcome.promise; }
  finally { timer.abort(); await deadline; stream.off('data', received); stream.off('end', closed); stream.off('error', closed); child.off('exit', closed); }
}
async function helper(pid: number, group: Cgroup, time: Clock): Promise<Result<Network, 'io'>> {
  const child = spawn('/bin/sh', ['-c', 'IFS= read -r ready <&5 || exit 1; exec 5<&-; exec /usr/bin/slirp4netns --configure --disable-host-loopback --enable-sandbox --enable-seccomp --ready-fd=3 --exit-fd=4 "$1" tap0', 'network', String(pid)], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
  const done = Promise.withResolvers<undefined>(); let stopped = false; let bytes = 0; let fault: Result<void, 'io'> = { ok: true, value: undefined };
  child.once('error', () => { fault = failure('io', 'The network helper failed to start.'); done.resolve(undefined); });
  child.once('exit', () => { if (!stopped) fault = failure('io', 'The network helper exited before its run.'); done.resolve(undefined); });
  const output = (chunk: Buffer): void => { bytes += chunk.length; if (bytes > networkLimits.outputBytes) { fault = failure('io', 'The network helper exceeded its output budget.'); child.kill('SIGKILL'); } };
  child.stdout?.on('data', output); child.stderr?.on('data', output);
  const gate = child.stdio.at(5); const status = child.stdio.at(3); const exit = child.stdio.at(4);
  if (!child.pid || !(gate instanceof Writable) || !(status instanceof Readable) || !(exit instanceof Writable) || !(await group.attach(child.pid)).ok) { stopped = true; child.kill('SIGKILL'); await done.promise; return failure('io', 'The network helper could not enter the run cgroup.'); }
  gate.on('error', () => { child.kill('SIGKILL'); }); exit.on('error', () => { child.kill('SIGKILL'); });
  const readiness = ready(status, child, time); gate.end('start\n'); const configured = await readiness;
  if (!configured.ok) { stopped = true; child.kill('SIGKILL'); await done.promise; return configured; }
  return { ok: true, value: { health: () => fault, async stop() { if (!stopped) { stopped = true; exit.end('stop'); child.kill('SIGKILL'); } await done.promise; return fault; } } };
}
export async function egress(child: ChildProcess, group: Cgroup, time: Clock = clock): Promise<Result<Network, 'io'>> {
  const status = child.stdio.at(7); const barrier = child.stdio.at(8); const dns = child.stdio.at(9);
  if (!child.pid || !(status instanceof Readable) || !(barrier instanceof Writable) || !(dns instanceof Writable)) return failure('io', 'The private network descriptors are missing.');
  barrier.on('error', () => { child.kill('SIGKILL'); }); dns.on('error', () => { child.kill('SIGKILL'); });
  const created = await ready(status, child, time); if (!created.ok) return created;
  const configured = await helper(child.pid, group, time); if (!configured.ok) return configured;
  dns.end('nameserver 10.0.2.3\noptions timeout:2 attempts:2\n'); barrier.end('ready\n');
  return configured;
}
