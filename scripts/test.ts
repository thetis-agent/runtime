/** Keep even development tests inside the mandatory namespace boundary; ADR 0012 §8. */
import { spawn } from 'node:child_process';
import { readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { namespace, seal } from '../lib/sandbox-runner/namespace.ts';
import { delegate } from '../lib/sandbox-runner/cgroup.ts';
const supervisor = { memoryMiB: 512, tasks: 128, cpuPercent: 100 };

async function files(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', '.runtime', '.agents', '.codex', 'docs'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(path));
    else if (entry.name.endsWith('.test.ts')) output.push(path);
  }
  return output.sort();
}

if (!process.argv.includes('--delegated')) {
  const child = spawn('systemd-run', ['--user', '--scope', '--quiet', '-p', 'Delegate=yes', '-p', `MemoryMax=${String(supervisor.memoryMiB)}M`, '-p', `TasksMax=${String(supervisor.tasks)}`, '-p', `CPUQuota=${String(supervisor.cpuPercent)}%`, process.execPath, new URL(import.meta.url).pathname, '--delegated'], { stdio: 'inherit' });
  child.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
} else {
  const control = await delegate();
  if (!control.ok) { process.stderr.write(`${control.error.message}\n`); process.exitCode = 1; }
  else await run(control.value);
}

async function run(control: string): Promise<void> {
  const root = await realpath(new URL('..', import.meta.url));
  const runtime = dirname(dirname(process.execPath));
  const args = [...namespace(runtime, 67108864), '--size', '67108864', '--tmpfs', '/packages',
    '--ro-bind', root, root, '--ro-bind', runtime, '/runtime', '--bind', control, '/cgroup', '--chdir', root,
    ...seal,
    '--', '/runtime/bin/node', '--test', '--test-concurrency=1', ...await files(root)
  ];
  const child = spawn('bwrap', args, { stdio: 'inherit', env: { PATH: '/usr/bin:/bin' } });
  child.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
}
