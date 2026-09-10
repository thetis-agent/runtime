/** Spawn offline verification tools without a shell or ambient PATH; ADR 0048, GN-002. */
import { spawn } from 'node:child_process';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';

export interface ToolOptions { cwd: string; input?: Uint8Array; deadlineMs: number; outputBytes: number }

export async function run(command: string, args: readonly string[], options: ToolOptions): Promise<Result<Buffer>> {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, options.deadlineMs);
  try {
    return await new Promise<Result<Buffer>>(resolve => {
      const child = spawn(command, [...args], { cwd: options.cwd, env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks: Buffer[] = []; let bytes = 0; let refused = false;
      controller.signal.addEventListener('abort', () => { child.kill('SIGKILL'); });
      child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > options.outputBytes) { refused = true; child.kill('SIGKILL'); } else chunks.push(chunk); });
      child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > options.outputBytes) { refused = true; child.kill('SIGKILL'); } });
      child.stdin.on('error', () => { refused = true; });
      child.once('error', (error: unknown) => {
        resolve(controller.signal.aborted ? failure('deadline', 'The verification tool exceeded its deadline.')
          : failure('io', isObject(error) ? 'The verification tool could not start.' : 'The verification tool failed.'));
      });
      child.once('close', code => {
        resolve(controller.signal.aborted ? failure('deadline', 'The verification tool exceeded its deadline.')
          : refused ? failure('budget', 'The verification tool exceeded its output budget.')
          : code === 0 ? { ok: true, value: Buffer.concat(chunks) } : failure('io', 'The verification tool was refused.'));
      });
      child.stdin.end(options.input);
    });
  } finally { clearTimeout(timer); }
}
