/** Produce artifacts only in explicit output mounts, never by evaluating packages; ADR 0035, ADR 0037. */
import { dirname, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildTree } from '@/lib/artifacts/build.ts';
import { namespace, seal } from '@/lib/sandbox-runner/namespace.ts';
import { sourceMounts, execute } from '@/scripts/workspace.ts';
import { packagesRoot } from '@/lib/profile/packages-root.ts';
const folders = ['kernel', 'contracts', 'lib', 'test', 'scripts', 'packages'];
if (process.argv.includes('--workspace')) {
  let fresh = true;
  for (const folder of folders) fresh = await buildTree(`/workspace/${folder}`, `/workspace/${folder}`, process.argv.includes('--check')) && fresh;
  if (!fresh) { process.stderr.write('Execution artifacts are stale; run scripts/build.ts.\n'); process.exitCode = 1; }
} else {
  const root = await realpath(fileURLToPath(new URL('..', import.meta.url))); const registry = await realpath(packagesRoot(root));
  const mounts = await sourceMounts(root);
  const writable = process.argv.includes('--check') ? [] : folders.flatMap(folder => ['--bind', folder === 'packages' ? registry : join(root, folder), `/workspace/${folder}`]);
  process.exitCode = await execute('bwrap', [...namespace(dirname(dirname(process.execPath)), 67108864), ...mounts, ...writable,
    '--chdir', '/workspace', ...seal, '--', '/runtime/bin/node', '--import', '/workspace/lib/artifacts/source.mjs', '/workspace/scripts/build.ts', '--workspace', ...process.argv.slice(2)]);
}
