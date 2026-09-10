/** Extract an immutable green tag inside the test sandbox without network access; KS-003. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, stat, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plan } from '@/lib/sandbox-runner/index.ts';

const execute = promisify(execFile);
export const previous = { tag: 'compatibility/socket-v1.0.0', commit: 'd8aa0d1200c7c24a0fa7f671c41eece204b377fe' };
export const limits = { archiveBytes: 16 * 1024 * 1024, outputBytes: 65536, commandMs: 10000 };

export async function compatibilityArchive() {
  const root = await mkdtemp('/tmp/socket-compatibility-'); const revision = join(root, 'revision'); await mkdir(revision);
  const repository = new URL('..', import.meta.url).pathname;
  const options = { cwd: repository, maxBuffer: limits.outputBytes, timeout: limits.commandMs, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } };
  try {
    const resolved = await execute('git', ['-c', `safe.directory=${repository}`, 'rev-parse', `${previous.tag}^{commit}`], options);
    if (resolved.stdout.trim() !== previous.commit) throw new Error('The socket compatibility tag moved.');
    const archive = join(root, 'previous.tar');
    await execute('git', ['-c', `safe.directory=${repository}`, 'archive', '--format=tar', `--output=${archive}`, previous.tag, 'kernel', 'lib', 'contracts'], options);
    if ((await stat(archive)).size > limits.archiveBytes) throw new Error('The compatibility archive exceeds its byte limit.');
    await execute('tar', ['--extract', '--file', archive, '--directory', revision, '--no-same-owner', '--no-same-permissions'], options);
    await mkdir(join(revision, 'node_modules'));
    const program = join(root, 'compatibility.ts');
    const source = await readFile(new URL('./fixtures/socket-compatibility.ts', import.meta.url), 'utf8');
    await writeFile(program, source.replaceAll('../../', '/revision/').replace('../socket-suite.ts', '/socket-suite.ts'));
    const plan: Omit<Plan, 'socket' | 'token' | 'args'> = { name: 'compatibility', version: '1.0.0', entry: '/compatibility.ts', cwd: '/tmp', mounts: [
      { source: revision, path: '/revision', mode: 'ro' }, { source: `${repository}node_modules`, path: '/revision/node_modules', mode: 'ro' },
      { source: program, path: '/compatibility.ts', mode: 'ro' }, { source: new URL('./socket-suite.ts', import.meta.url).pathname, path: '/socket-suite.ts', mode: 'ro' }
    ] };
    return { plan, close: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
