/** Prevent implicit authority inheritance within an existing sandbox; TE-024, ADR 0021. */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/** `input` opens stdin as a pipe. Off by default: a child that inherits no way to be spoken to is
 *  the safer shape, and only a stage that means to type into one — a terminal — asks for the pipe. */
export function spawnChild(command: string, args: readonly string[], cwd?: string, input = false): ChildProcess {
  return spawn(command, args, {
    ...(cwd === undefined ? {} : { cwd }),
    env: { PATH: '/runtime/bin:/usr/bin:/bin' },
    stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: false
  });
}
