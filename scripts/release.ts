/** Export real immutable registry objects and their matching profile without inventing pins; ADR 0007, GN-002. */
import { mkdir, realpath, mkdtemp, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { namespace, seal } from '../lib/sandbox-runner/namespace.ts';
import { sourceMounts, execute } from './workspace.ts';
import { Registry } from '../lib/registry/index.ts';
import { git } from '../lib/registry/git.ts';
import { Schemas } from '../lib/schema/index.ts';
import { bootstrap, writeProfile } from '../lib/profile/bootstrap.ts';
import { atomicWrite } from '../lib/files/atomic.ts';
import { fileChunks } from '../lib/ndjson/file.ts';
const limits = { temporaryBytes: 536870912, bundleBytes: 67108864 };

async function release(): Promise<void> {
  const root = await mkdtemp('/tmp/release-'); const schemas = new Schemas(); await schemas.load();
  const path = join(root, 'registry'); const initialized = await git(path, ['init', '--bare']); if (!initialized.ok) throw new Error(initialized.error.message);
  const registry = await Registry.open(path, schemas); if (!registry.ok) throw new Error(registry.error.message);
  const released = await bootstrap('/workspace', registry.value, join(root, 'cache'), 0); if (!released.ok) throw new Error(released.error.message);
  const bundle = join(root, 'registry.bundle'); const bundled = await git(path, ['-c', 'pack.threads=1', 'bundle', 'create', bundle, '--all']); if (!bundled.ok) throw new Error(bundled.error.message);
  const digest = createHash('sha256'); let bytes = 0;
  for await (const chunk of fileChunks(bundle)) {
    bytes += chunk.length; if (bytes > limits.bundleBytes) throw new Error('The release bundle exceeds its byte budget.');
    digest.update(chunk);
  }
  const hash = digest.digest('hex');
  await copyFile(bundle, '/release/registry.bundle');
  const recorded = await atomicWrite('/release/registry.json', Buffer.from(`${JSON.stringify({ bundle: './registry.bundle', sha256: hash, pins: released.value.profile.pins.length }, null, 2)}\n`)); if (!recorded.ok) throw new Error(recorded.error.message);
  const profile = await writeProfile(released.value.profile, '/release'); if (!profile.ok) throw new Error(profile.error.message);
  process.stdout.write(`${JSON.stringify({ release: 'default', pins: released.value.profile.pins.length, bundleSha256: hash })}\n`);
}

if (process.argv.includes('--workspace')) await release();
else {
  const destination = resolve(process.argv[2] ?? 'profiles/default'); await mkdir(destination, { recursive: true });
  const args = [...namespace(dirname(dirname(process.execPath)), limits.temporaryBytes), ...await sourceMounts(fileURLToPath(new URL('..', import.meta.url))),
    '--bind', await realpath(destination), '/release', '--chdir', '/workspace', ...seal, '--', '/runtime/bin/node', '/workspace/scripts/release.ts', '--workspace'];
  process.exitCode = await execute('bwrap', args);
}
