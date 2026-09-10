/** Deliver verified execution sources and the offline dependency closure; ADR 0035, ADR 0037, GN-002. */
import { cp, mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalog } from '../lib/profile/catalog.ts';
import { namespace, seal } from '../lib/sandbox-runner/namespace.ts';
import { sourceMounts, execute } from './workspace.ts';
const limits = { temporaryBytes: 536870912 };

async function distribution(): Promise<number> {
  const stage = await mkdtemp('/tmp/distribution-');
  const sources = await catalog('/workspace');
  if (!sources.ok) throw new Error(sources.error.message);
  for (const source of sources.value) {
    await cp(source.source, join(stage, source.kind, source.directory), { recursive: true, errorOnExist: true, force: false });
  }
  for (const path of ['kernel', 'profiles', 'docs', 'README.md', 'package.json', 'package-lock.json']) {
    await cp(join('/workspace', path), join(stage, path), { recursive: true, errorOnExist: true, force: false });
  }
  // Stable metadata makes independent archives comparable. The namespace bounds
  // the staging filesystem and supplies no network, credentials or live state.
  return execute('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
    '-czf', '/delivery/thetis-distribution.tar.gz', '-C', stage, '.']);
}

if (process.argv.includes('--workspace')) process.exitCode = await distribution();
else {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const output = resolve(process.argv[2] ?? '.runtime/delivery');
  await mkdir(output, { recursive: true });
  process.exitCode = await execute('bwrap', [...namespace(dirname(dirname(process.execPath)), limits.temporaryBytes),
    ...await sourceMounts(root), '--bind', await realpath(output), '/delivery', '--chdir', '/workspace', ...seal,
    '--', '/runtime/bin/node', '/workspace/scripts/distribution.ts', '--workspace']);
}
