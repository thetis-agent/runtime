/** Score only a frozen read-only space in the mandatory sandbox; EV-002, ADR 0004 §1. */
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { realpath, mkdtemp, writeFile, rm } from 'node:fs/promises';
import type { SandboxRunner, Plan } from '@/lib/sandbox-runner/index.ts';
import type { Clock } from '@/lib/events/index.ts';
import { failure } from '@/lib/result/index.ts';
import type { Result } from '@/lib/result/index.ts';

export const scorerLimits = { active: 2, deadlineMs: 10000, outputBytes: 65536 };
export interface ScorerInput { checks: string; snapshot: string; authority: Pick<Plan, 'socket' | 'token'>; replacements?: Readonly<Record<string, string>> }
export class Scorer {
  #active = 0;
  readonly #runner: SandboxRunner;
  readonly #clock: Clock;
  constructor(runner: SandboxRunner, clock: Clock) { this.#runner = runner; this.#clock = clock; }

  async run(input: ScorerInput): Promise<Result<{ pass: boolean; exit: number | null }>> {
    if (this.#active >= scorerLimits.active) return failure('budget', 'The scorer process pool is exhausted.');
    this.#active++; let directory: string | undefined;
    let result: Result<{ pass: boolean; exit: number | null }>;
    try {
      directory = await mkdtemp('/tmp/scorer-input-');
      const mutation = JSON.stringify(input.replacements ?? {});
      if (Buffer.byteLength(mutation) > 65536) result = failure('budget', 'The scorer mutation exceeds its byte limit.');
      else { await writeFile(join(directory, 'variant.json'), mutation, { mode: 0o600 }); result = await this.#run(input, directory); }
    } catch { result = failure('outside-roots', 'The scorer inputs could not be canonicalised.'); }
    finally { this.#active--; }
    try { if (directory) await rm(directory, { recursive: true, force: true }); }
    catch { return failure('io', 'The scorer private input could not be removed.'); }
    return result;
  }

  async #run(input: ScorerInput, directory: string): Promise<Result<{ pass: boolean; exit: number | null }>> {
    const checks = await realpath(input.checks); const snapshot = await realpath(input.snapshot);
    const entry = fileURLToPath(new URL('./scorer-entry.ts', import.meta.url));
    const started = await this.#runner.start({ name: 'scorer', version: '1.0.0', entry: '/scorer/scorer-entry.ts', args: [`/checks/${basename(checks)}`], cwd: '/space', ...input.authority,
      mounts: [{ source: join(directory, 'variant.json'), path: '/variant.json', mode: 'ro' }, { source: dirname(entry), path: '/scorer', mode: 'ro' }, { source: dirname(checks), path: '/checks', mode: 'ro' }, { source: snapshot, path: '/space', mode: 'ro' }] });
    if (!started.ok) return started;
    const process = started.value; const output = { bytes: 0, overflow: false };
    for (const stream of [process.process.stdout, process.process.stderr]) stream?.on('data', (chunk: Buffer) => { output.bytes += chunk.byteLength; if (output.bytes > scorerLimits.outputBytes) { output.overflow = true; process.process.kill('SIGKILL'); } });
    const abort = new AbortController();
    const exit = await Promise.race([process.exited, this.#clock.wait(scorerLimits.deadlineMs, abort.signal).then(() => undefined)]);
    abort.abort(); const stopped = await process.stop(); if (!stopped.ok) return stopped;
    if (!exit) return failure('deadline', 'The scorer exceeded its deadline.');
    if (output.overflow) return failure('budget', 'The scorer exceeded its output byte limit.');
    return { ok: true, value: { pass: exit.code === 0, exit: exit.code } };
  }
}
