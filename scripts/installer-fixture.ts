/** Build signed, offline install inputs in the mandatory namespace for real service acceptance. */
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { namespace, seal } from '@/lib/sandbox-runner/namespace.ts';
import { sourceMounts, execute } from '@/scripts/workspace.ts';

if (process.argv.includes('--workspace')) {
  const { remote } = await import('@/test/installer-fixture.ts');
  const { buildRelease } = await import('@/test/release-fixture.ts');
  const source = await remote('/output/runtime.git', 'system-service acceptance');
  await mkdir('/output/published', { recursive: true });
  await buildRelease('/output/published/v0.1.0', { tag: 'v0.1.0', commit: source.commit, nodeArchive: true });
} else {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const output = resolve(process.argv[2] ?? '');
  if (!process.argv[2] || await realpath(output) !== output) throw new Error('Provide a new canonical fixture output directory.');
  await writeFile(join(output, 'passwd'), `fixture:x:${String(process.getuid?.())}:${String(process.getgid?.())}:fixture:/tmp:/bin/sh\n`, { mode: 0o600 });
  process.exitCode = await execute('bwrap', [...namespace(dirname(dirname(process.execPath)), 1073741824),
    ...await sourceMounts(root), '--dir', '/etc', '--ro-bind', join(output, 'passwd'), '/etc/passwd',
    '--bind', output, '/output', '--chdir', '/workspace', ...seal,
    '--', '/runtime/bin/node', '--import', '/workspace/lib/artifacts/source.mjs', '/workspace/scripts/installer-fixture.ts', '--workspace']);
}
