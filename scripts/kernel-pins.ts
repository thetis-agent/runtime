/** Print a release's kernel-pins.json body from an installed-layout checkout; ADR 0048, GN-002. */
import { resolve } from 'node:path';
import { kernelPins } from '@/scripts/distribution-tree.ts';

/** test/maintenance.test.ts's eleven kernel code pins, plus `packages`; ADR 0048's `kernel-pins.json`. */
export { kernelPinDirectories } from '@/scripts/distribution-tree.ts';

const root = resolve(process.argv[2] ?? '.');
const body = await kernelPins(root);
process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
