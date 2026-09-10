/** Mount kernel layers and named registry packages at their host paths; ADR 0005, ADR 0007. */
import { join } from 'node:path';
import type { Mount } from '../lib/sandbox-runner/index.ts';
import { packagesRoot } from '../lib/profile/packages-root.ts';

export function packageEntry(repository: string, name: string, file: string): string {
  return join(packagesRoot(repository), name, file);
}

export function packageMounts(repository: string, names: readonly string[]): Mount[] {
  const registry = packagesRoot(repository);
  return [
    ...['lib', 'contracts', 'node_modules'].map((name): Mount => ({ source: join(repository, name), path: join(repository, name), mode: 'ro' })),
    ...[...new Set(names)].map((name): Mount => ({ source: join(registry, name), path: join(registry, name), mode: 'ro' }))
  ];
}
