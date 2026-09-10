/** Locate the development package registry without embedding it in this tree; proposal §5, ADR 0007. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function kernelRoot(): string {
  return process.env.THETIS_KERNEL ?? fileURLToPath(new URL('../..', import.meta.url));
}

export function packagesRoot(repository = kernelRoot()): string {
  const local = join(repository, 'packages');
  if (existsSync(local)) return local;
  return process.env.THETIS_PACKAGES ?? join(repository, '..', 'packages');
}
