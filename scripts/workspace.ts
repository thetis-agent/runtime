/** Check separate source repositories in their installed layout; ADR 0035. */
import { spawn } from 'node:child_process';
import { readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packagesRoot } from '@/lib/profile/packages-root.ts';
import { namespace, seal } from '@/lib/sandbox-runner/namespace.ts';

export const workspace = '/workspace';
export const workspaceLimits = { entries: 256, temporaryBytes: 67108864 };

export async function sourceMounts(root: string): Promise<string[]> {
  const repository = await realpath(root);
  const registry = await realpath(packagesRoot(repository));
  const entries = await readdir(repository, { withFileTypes: true });
  if (entries.length > workspaceLimits.entries) throw new Error('The development workspace exceeds its entry limit.');
  const mounts: string[] = ['--dir', workspace];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (['packages', '.runtime', '.registry', '.agents', '.codex'].includes(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error(`The development workspace entry is not canonical: ${entry.name}`);
    mounts.push('--ro-bind', join(repository, entry.name), join(workspace, entry.name));
  }
  mounts.push('--ro-bind', registry, join(workspace, 'packages'));
  return mounts;
}

export async function execute(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => { resolve(code ?? 1); });
  });
}

export async function checkWorkspace(): Promise<number> {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const runtime = dirname(dirname(process.execPath));
  return execute('bwrap', [...namespace(runtime, workspaceLimits.temporaryBytes), ...await sourceMounts(root),
    '--chdir', workspace, ...seal, '--', '/runtime/bin/node', '--import', `${workspace}/lib/artifacts/source.mjs`, `${workspace}/scripts/check.ts`, '--workspace']);
}
