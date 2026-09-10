/** Hold an OS lock before reaping writers or retiring a stale trusted socket; ADR 0030, GN-002. */
import { spawn } from 'node:child_process';
import { lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Socket } from 'node:net';
import { resolvePath } from '@/lib/files/index.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import type { Clock } from '@/lib/events/index.ts';
export const exclusiveLimits = { deadlineMs: 10000, outputBytes: 32 };
export interface Exclusive { close(): Promise<Result<void>> }
export async function exclusive(root: string, clock: Clock): Promise<Result<Exclusive>> {
  await mkdir(root, { recursive: true, mode: 0o700 }); const path = join(await realpath(root), '.kernel.lock');
  const current = await lstat(path).catch((error: unknown) => { if (isObject(error) && error['code'] === 'ENOENT') return undefined; throw error; });
  if (current && !current.isFile()) return failure('outside-roots', 'The kernel lock exists but is not a regular file.');
  const child = spawn('/usr/bin/flock', ['--nonblock', '--conflict-exit-code', '75', '--', path, '/usr/bin/cat'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const ready = Promise.withResolvers<Result<void>>(); const exited = Promise.withResolvers<number | null>(); let bytes = '';
  child.once('error', () => { ready.resolve(failure('io', 'The kernel lock helper could not start.')); exited.resolve(null); });
  child.once('exit', code => { exited.resolve(code); ready.resolve(failure(code === 75 ? 'conflict' : 'io', 'The deployment kernel lock is unavailable.')); });
  child.stdin.on('error', () => { ready.resolve(failure('conflict', 'The deployment kernel lock is unavailable.')); });
  child.stderr.on('data', () => { ready.resolve(failure('io', 'The kernel lock helper failed.')); });
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.toString('utf8');
    if (bytes === 'locked\n') ready.resolve({ ok: true, value: undefined });
    else if (bytes.length > exclusiveLimits.outputBytes || bytes.includes('\n')) ready.resolve(failure('io', 'The kernel lock helper returned invalid output.'));
  });
  child.stdin.write('locked\n'); const timer = new AbortController();
  const obtained = await Promise.race([ready.promise, clock.wait(exclusiveLimits.deadlineMs, timer.signal).then(() => failure('deadline', 'The kernel lock exceeded its startup deadline.'))]); timer.abort();
  if (!obtained.ok) { child.kill('SIGKILL'); await exited.promise; return obtained; }
  let closed: Promise<Result<void>> | undefined;
  return { ok: true, value: { close: () => { closed ??= (async () => { child.stdin.end(); return await exited.promise === 0 ? { ok: true, value: undefined } : failure('io', 'The kernel lock helper did not stop cleanly.'); })(); return closed; } } };
}
export async function retireOrigin(root: string, socketPath: string): Promise<Result<void>> {
  const path = await resolvePath(socketPath, [{ path: root, mode: 'rw', space: 'kernel origin' }], true); if (!path.ok) return path;
  const existing = await lstat(path.value).catch((error: unknown) => { if (isObject(error) && error['code'] === 'ENOENT') return undefined; throw error; });
  if (!existing) return { ok: true, value: undefined };
  if (!existing.isSocket()) return failure('outside-roots', 'The kernel origin exists but is not a socket.');
  const unused = await new Promise<boolean>(resolve => {
    const socket = new Socket(); socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', (error: unknown) => { resolve(isObject(error) && error['code'] === 'ECONNREFUSED'); }); socket.connect(path.value);
  });
  if (!unused) return failure('conflict', 'The kernel origin socket is still owned by a live or inaccessible endpoint.');
  await unlink(path.value); return { ok: true, value: undefined };
}
