/** Compose already validated declarations without choosing their authority; ADR 0016, implementation note 0045. */
import type { Entry, Registration } from './types.ts';
import type { Package } from '@/lib/semver-match/index.ts';

export interface Declaration { source: string; registration: Registration }

export function compose(entries: readonly Entry[], scope: Package['scope'], declarations: readonly Declaration[]): Package[] {
  const registrations = new Map(declarations.map(declaration => [declaration.source, declaration.registration]));
  return entries.map(entry => {
    const registration = registrations.get(`${entry.manifest.name}@${entry.manifest.version}`);
    return { name: entry.manifest.name, version: entry.manifest.version, scope,
      requires: { ...entry.manifest.requires, ...registration?.requires },
      provides: { ...entry.manifest.provides, ...registration?.provides } };
  });
}
