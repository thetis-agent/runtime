/** Bound compilation off the caller loop and leave all authority descriptors behind; ADR 0037, KS-001. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { failure } from '../result/index.ts';
import type { Result } from '../result/index.ts';
import validate from './reply.mjs';
export const limits = { processes: 1, deadlineMs: 10000, outputBytes: 16384, heapMiB: 32 };
let active = 0;
export function flags(): string[] { return ['--no-experimental-strip-types', '--import', fileURLToPath(new URL('./register.mjs', import.meta.url))]; }
export async function compile(source: string, destination: string, previous?: string): Promise<Result<void>> {
  if ([source, destination, previous ?? ''].some(path => Buffer.byteLength(path) > 4096)) return failure('budget', 'The compilation paths exceed their byte limit.');
  if (active >= limits.processes) return failure('budget', 'The compilation process pool is full.');
  active++;
  try {
    return await new Promise(resolve => {
      const child = spawn(process.execPath, [`--max-old-space-size=${String(limits.heapMiB)}`, fileURLToPath(new URL('./child.ts', import.meta.url))], { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; let bytes = 0; let expired = false;
      const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, limits.deadlineMs);
      child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > limits.outputBytes) child.kill('SIGKILL'); else output += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > limits.outputBytes) child.kill('SIGKILL'); });
      child.stdin.once('error', () => { child.kill('SIGKILL'); });
      child.once('error', () => { clearTimeout(timer); resolve(failure('io', 'The compilation process could not start.')); });
      child.once('close', code => {
        clearTimeout(timer);
        if (expired) { resolve(failure('deadline', 'The compilation process exceeded its deadline.')); return; }
        if (bytes > limits.outputBytes) { resolve(failure('budget', 'The compilation process exceeded its output limit.')); return; }
        try { const reply: unknown = JSON.parse(output); resolve(!validate(reply) ? failure('io', 'The compilation result violates its schema.') : !reply.ok ? reply : code === 0 ? { ok: true, value: undefined } : failure('io', 'The compilation process exited unsuccessfully.')); }
        catch { resolve(failure('io', 'The compilation process returned an invalid result.')); }
      });
      child.stdin.end(JSON.stringify({ source, destination, previous }));
    });
  } finally { active--; }
}
