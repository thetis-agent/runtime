/** Launch only the trusted kernel itself outside the environment runner and bound its private controls; GN-007. */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Clock } from '../events/index.ts';
import { failure } from '../schema/index.ts';
import type { Result, Schemas } from '../schema/index.ts';
import schema from './schema.json' with { type: 'json' };
import type { Command, Ready, Reply, Status } from './types.ts';

export const processLimits = { outputBytes: 65536, frameBytes: 65536, messages: 256, freezePolls: 128, deadlineMs: 10000 };
export interface Launch { entry: string; configuration: string; endpoint: string; administrator: string; mode: 'probe' | 'serve'; descriptors?: readonly number[] }
export class KernelProcess {
  readonly process: ChildProcess; readonly endpoint: string;
  readonly #clock: Clock; readonly #schemas: Schemas;
  readonly #pending = new Map<string, (result: Result<unknown>) => void>();
  readonly #ready = Promise.withResolvers<Result<void>>();
  readonly #exited: Promise<void>;
  #closed = false; #counter = 0; #bytes = 0;
  private constructor(child: ChildProcess, endpoint: string, schemas: Schemas, clock: Clock) {
    this.process = child; this.endpoint = endpoint; this.#schemas = schemas; this.#clock = clock;
    this.#exited = new Promise(resolve => { child.once('exit', () => { this.#closed = true; this.#fail(); resolve(); }); child.once('error', () => { this.#closed = true; this.#fail(); resolve(); }); });
    const ready = schemas.compile<Ready>({ ...schema, $id: 'thetis://internal/maintenance/ready', $ref: '#/$defs/ready' });
    const reply = schemas.compile<Reply>({ ...schema, $id: 'thetis://internal/maintenance/reply', $ref: '#/$defs/reply' });
    child.on('message', (value: unknown) => {
      if (++this.#counter > processLimits.messages || Buffer.byteLength(JSON.stringify(value)) > processLimits.frameBytes) { child.kill('SIGKILL'); this.#fail(); return; }
      if (ready(value) && value.endpoint === endpoint) this.#ready.resolve({ ok: true, value: undefined });
      else if (reply(value)) { this.#pending.get(value.id)?.(value.ok ? { ok: true, value: value.value } : value); this.#pending.delete(value.id); }
      else { child.kill('SIGKILL'); this.#fail(); }
    });
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', (bytes: Buffer) => { this.#bytes += bytes.length; if (this.#bytes > processLimits.outputBytes) { child.kill('SIGKILL'); this.#fail(); } });
  }
  static async start(input: Launch, schemas: Schemas, clock: Clock): Promise<Result<KernelProcess>> {
    let child: ChildProcess;
    try { child = spawn(process.execPath, [input.entry, input.configuration, input.endpoint, input.mode, input.administrator], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc', ...input.descriptors ?? []] }); }
    catch { return failure('io', 'The trusted kernel process could not be launched.'); }
    const kernel = new KernelProcess(child, input.endpoint, schemas, clock); const timer = new AbortController();
    try {
      const ready = await Promise.race([kernel.#ready.promise, clock.wait(processLimits.deadlineMs, timer.signal).then(() => failure('deadline', 'The candidate kernel did not become ready.'))]);
      if (!ready.ok) { await kernel.kill(); return ready; }
      return { ok: true, value: kernel };
    } finally { timer.abort(); }
  }
  async call(method: Command['method']): Promise<Result<unknown>> {
    if (this.#closed) return failure('io', 'The trusted kernel process is stopped.');
    if (this.#pending.size) return failure('budget', 'The trusted kernel control pool is full.');
    const id = randomUUID(); const timer = new AbortController();
    const reply = new Promise<Result<unknown>>(resolve => { this.#pending.set(id, resolve); });
    this.process.send({ id, method }, error => { if (error) this.#pending.get(id)?.(failure('io', 'The trusted kernel command could not be sent.')); });
    try { return await Promise.race([reply, this.#clock.wait(processLimits.deadlineMs, timer.signal).then(() => failure('deadline', 'The trusted kernel command exceeded its deadline.'))]); }
    finally { timer.abort(); this.#pending.delete(id); }
  }
  async clients(): Promise<Result<readonly string[]>> {
    const reply = await this.call('status'); if (!reply.ok) return reply;
    return this.#schemas.compile<Status>({ ...schema, $id: 'thetis://internal/maintenance/status', $ref: '#/$defs/status' })(reply.value)
      ? { ok: true, value: reply.value.clients } : failure('invalid-args', 'The kernel returned an invalid client-major set.');
  }
  async freeze(frozen: boolean): Promise<Result<void>> {
    if (!this.process.pid || !this.process.kill(frozen ? 'SIGSTOP' : 'SIGCONT')) return failure('io', 'The trusted kernel could not be frozen or resumed.');
    if (!frozen) return { ok: true, value: undefined };
    try {
      for (let attempt = 0; attempt < processLimits.freezePolls; attempt++) if (/^State:\s+T/mu.test(await readFile(`/proc/${String(this.process.pid)}/status`, 'utf8'))) return { ok: true, value: undefined };
      return failure('deadline', 'The trusted kernel did not enter its stopped state.');
    } catch { return failure('io', 'The trusted kernel stopped state could not be observed.'); }
  }
  async stop(): Promise<Result<void>> {
    if (this.#closed) return { ok: true, value: undefined };
    const resumed = await this.freeze(false); if (!resumed.ok) return resumed;
    const closed = await this.call('stop'); if (!closed.ok) { await this.kill(); return closed; }
    const timer = new AbortController();
    try {
      const exited = await Promise.race([this.#exited.then(() => true), this.#clock.wait(processLimits.deadlineMs, timer.signal).then(() => false)]);
      if (!exited) { await this.kill(); return failure('deadline', 'The trusted kernel did not exit after shutdown.'); }
      return { ok: true, value: undefined };
    } finally { timer.abort(); }
  }
  async kill(): Promise<void> { if (!this.#closed) this.process.kill('SIGKILL'); await this.#exited; }
  #fail(): void {
    const result = failure('io', 'The trusted kernel process exited or violated its control boundary.');
    this.#ready.resolve(result); for (const finish of this.#pending.values()) finish(result); this.#pending.clear();
  }
}
