/** Open the real web surface on a loopback port for a person to look at; ADR 0012 §8.
 *
 * The same mandatory namespace every other development entry point uses, minus the network unshare —
 * a browser on this machine has to be able to reach the port, and nothing else here does. The surface
 * it serves is the shipped gateway against the mock provider, so it needs no key and no external
 * network of its own.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { namespace, seal } from '@/lib/sandbox-runner/namespace.ts';
import { delegate } from '@/lib/sandbox-runner/cgroup.ts';
import { sourceMounts, workspace } from '@/scripts/workspace.ts';
import { sourceFlags } from '@/lib/artifacts/index.ts';

const supervisor = { memoryMiB: 2048, tasks: 128, cpuPercent: 100, temporaryBytes: 67108864 };

async function run(control: string, port: string): Promise<number> {
  const root = await realpath(new URL('..', import.meta.url));
  const args = [...namespace(dirname(dirname(process.execPath)), supervisor.temporaryBytes).filter(argument => argument !== '--unshare-net'),
    '--dir', '/etc', '--dir', '/run', ...await sourceMounts(root), '--bind', control, '/cgroup', '--chdir', workspace, ...seal,
    '--', '/runtime/bin/node', '--import', join(workspace, 'lib/artifacts/source.mjs'), join(workspace, 'test/surface-main.ts'), port];
  const child = spawn('bwrap', args, { stdio: 'inherit', env: { PATH: '/usr/bin:/bin' } });
  return new Promise<number>(resolve => { child.once('error', () => { resolve(1); }); child.once('exit', code => { resolve(code ?? 1); }); });
}

const port = process.argv.find(argument => /^\d+$/u.test(argument)) ?? '8787';
if (process.argv.includes('--delegated')) {
  const control = await delegate();
  if (!control.ok) { process.stderr.write(`${control.error.message}\n`); process.exitCode = 1; }
  else process.exitCode = await run(control.value, port);
} else {
  const child = spawn('systemd-run', ['--user', '--scope', '--quiet', '-p', 'Delegate=yes', '-p', `MemoryMax=${String(supervisor.memoryMiB)}M`,
    '-p', `TasksMax=${String(supervisor.tasks)}`, '-p', `CPUQuota=${String(supervisor.cpuPercent)}%`,
    process.execPath, ...sourceFlags(), new URL(import.meta.url).pathname, '--delegated', port], { stdio: 'inherit' });
  child.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
}
