/** Disable ambient git execution and bound local plumbing; proposal §5, ADR 0007. */
import { spawn } from 'node:child_process';
import { failure } from '@/lib/result/index.ts';
import type { Result } from '@/lib/result/index.ts';
export const limits = { processes: 2, outputBytes: 16777216, entries: 10000, fileBytes: 16777216, treeBytes: 67108864, versions: 4096, noteBytes: 4096, commandMs: 30000 };
let active = 0;
export async function git(path: string, args: string[], input?: Uint8Array, extra: Record<string, string> = {}): Promise<Result<Buffer>> {
  if (active >= limits.processes) return failure('budget', 'The registry process pool is full.');
  active++;
  try {
    return await new Promise<Result<Buffer>>(resolve => {
      const child = spawn('/usr/bin/git', ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-c', 'gc.auto=0', '--git-dir', path, ...args], {
        env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', ...extra }, stdio: ['pipe', 'pipe', 'pipe']
      });
      const deadline = setTimeout(() => { child.kill('SIGKILL'); }, limits.commandMs);
      const chunks: Buffer[] = []; let bytes = 0; let refused = false;
      child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > limits.outputBytes) { refused = true; child.kill('SIGKILL'); } else chunks.push(chunk); });
      child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > limits.outputBytes) { refused = true; child.kill('SIGKILL'); } });
      child.stdin.on('error', () => { refused = true; });
      child.once('error', () => { resolve(failure('io', 'The local registry command could not start.')); });
      child.once('close', code => { clearTimeout(deadline); resolve(refused ? failure('budget', 'The registry command exceeded its output budget.') : code === 0 ? { ok: true, value: Buffer.concat(chunks) } : failure('io', 'The local registry command was refused.')); });
      child.stdin.end(input);
    });
  } finally { active--; }
}
export function reference(name: string, version: string): string { return `refs/tags/${name}@${version}`; }
