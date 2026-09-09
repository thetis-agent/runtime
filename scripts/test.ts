/** Keep even development tests inside the mandatory namespace boundary; ADR 0012 §8. */
import { spawn } from 'node:child_process';
import { readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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

const root = await realpath(new URL('..', import.meta.url));
const runtime = dirname(dirname(process.execPath));
const args = [
  '--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts',
  '--die-with-parent', '--new-session', '--clearenv',
  '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
  '--symlink', 'usr/bin', '/bin', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
  '--ro-bind', root, root, '--ro-bind', runtime, '/runtime', '--chdir', root,
  '--setenv', 'PATH', '/runtime/bin:/usr/bin:/bin',
  '--', '/runtime/bin/node', '--test', '--test-concurrency=1', ...await files(root)
];
const child = spawn('bwrap', args, { stdio: 'inherit', env: { PATH: '/usr/bin:/bin' } });
child.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
