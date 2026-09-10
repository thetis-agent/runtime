/** Keep a real child alive through a stubborn shutdown hook to exercise the fence; TE-023. */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
let child: ChildProcess | undefined;
let state = '';
export async function init(_profile: unknown, context: { state: string }): Promise<void> {
  state = context.state;
  child = spawn(process.execPath, [new URL('./shutdown-child.ts', import.meta.url).pathname], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => { child?.stdout?.once('data', () => { resolve(); }); child?.once('error', reject); });
}
export const stages = { async shutdown(): Promise<void> {
  await writeFile(`${state}/shutdown-started`, 'waiting for child');
  await new Promise<void>(resolve => { child?.once('exit', () => { resolve(); }); });
} };
