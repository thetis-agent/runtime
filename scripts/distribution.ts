/** Deliver verified execution sources and the offline dependency closure; ADR 0035, ADR 0037, GN-002. */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDistribution, verifyDistribution } from '@/scripts/distribution-tree.ts';
import { namespace, seal } from '@/lib/sandbox-runner/namespace.ts';
import { sourceMounts, execute } from '@/scripts/workspace.ts';
const limits = { temporaryBytes: 1073741824 };

async function distribution(): Promise<number> {
  const stage = await mkdtemp('/tmp/distribution-');
  try {
    await buildDistribution('/workspace', join(stage, 'tree'), '/delivery');
    await verifyDistribution('/delivery', join(stage, 'extracted'));
    return 0;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

if (process.argv.includes('--workspace')) process.exitCode = await distribution();
else {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const output = resolve(process.argv[2] ?? '.runtime/delivery');
  await mkdir(output, { recursive: true });
  process.exitCode = await execute('bwrap', [...namespace(dirname(dirname(process.execPath)), limits.temporaryBytes),
    ...await sourceMounts(root), '--bind', await realpath(output), '/delivery', '--chdir', '/workspace', ...seal,
    '--', '/runtime/bin/node', '--import', '/workspace/lib/artifacts/source.mjs', '/workspace/scripts/distribution.ts', '--workspace']);
}
