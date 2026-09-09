/** Prevent implicit authority inheritance within an existing sandbox; TE-024, ADR 0021. */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

export function spawnChild(command: string, args: readonly string[], cwd?: string): ChildProcess {
  return spawn(command, args, {
    ...(cwd === undefined ? {} : { cwd }),
    env: { PATH: '/runtime/bin:/usr/bin:/bin' },
    stdio: ['ignore', 'pipe', 'pipe'], detached: false
  });
}
