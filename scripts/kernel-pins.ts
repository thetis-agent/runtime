/** Print a release's kernel-pins.json body from an installed-layout checkout; ADR 0048, GN-002. */
import { join, resolve } from 'node:path';
import { snapshot } from '@/lib/snapshots/index.ts';
import { packagesRoot } from '@/lib/profile/packages-root.ts';

/** test/maintenance.test.ts's eleven kernel code pins, plus `packages`; ADR 0048's `kernel-pins.json`. */
export const kernelPinDirectories = ['kernel', 'lib', 'contracts',
  ...['ajv', 'semver', 'ws', 'yaml', 'fast-uri', 'fast-deep-equal', 'json-schema-traverse', 'require-from-string'].map(name => `node_modules/${name}`),
  'packages'];

async function pins(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const directory of kernelPinDirectories) {
    const source = directory === 'packages' ? packagesRoot(root) : join(root, directory);
    const hash = await snapshot(source);
    if (!hash.ok) throw new Error(`${directory}: ${hash.error.message}`);
    result[directory] = hash.value;
  }
  return result;
}

const root = resolve(process.argv[2] ?? '.');
const body = { entry: 'kernel/maintenance-main.ts', pins: await pins(root) };
process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
