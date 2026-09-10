/** Resolve requirements by names and ranges without assigning package roles; proposal §3, ADR 0016. */
import { satisfies, valid, validRange } from 'semver';
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';

export interface Package {
  name: string; version: string; scope: 'person' | 'deployment';
  requires: Readonly<Record<string, string>>; provides: Readonly<Record<string, string>>;
}
export interface Provision { name: string; version: string; scope: 'person' | 'deployment'; owner: string }
export interface Suggestion { name: string; version: string; registry: string }
type Code = 'gap' | 'collision' | 'cycle' | 'scope' | 'envelope' | 'invalid-args';

export function gap(pkg: Pick<Package, 'name' | 'version'>, name: string, range: string, suggestion?: Suggestion): string {
  const provider = suggestion ? `${suggestion.name} ${suggestion.version} in the ${suggestion.registry} registry does.` : 'No configured registry provides it.';
  return `${pkg.name} ${pkg.version} requires ${name} ${range}. Nothing in this profile provides it. ${provider}`;
}

export function matches(version: string, range: string): boolean {
  return valid(version) !== null && validRange(range) !== null && satisfies(version, range);
}

export function resolve(packages: readonly Package[], facts: readonly Provision[] = []): Result<Package[], Code> {
  const provisions = new Map<string, Provision>();
  const graph = new Map<string, Set<string>>();
  const byName = new Map<string, Package>();
  for (const fact of facts) {
    if (provisions.has(fact.name)) return failure('collision', `${fact.name} has two providers.`);
    provisions.set(fact.name, fact);
  }
  for (const pkg of packages) {
    if (byName.has(pkg.name)) return failure('collision', `${pkg.name} has two versions in this profile.`);
    if (!valid(pkg.version)) return failure('invalid-args', `${pkg.name} has an invalid version.`);
    byName.set(pkg.name, pkg); graph.set(pkg.name, new Set());
    for (const [name, version] of Object.entries({ [pkg.name]: pkg.version, ...pkg.provides })) {
      if (/^(secret|cap|setting)\//u.test(name)) return failure('envelope', `${pkg.name} cannot provide ${name}; the environment supplies it.`);
      const existing = provisions.get(name);
      if (existing) return failure('collision', `${name} is provided by both ${existing.owner} and ${pkg.name}.`);
      provisions.set(name, { name, version, scope: pkg.scope, owner: pkg.name });
    }
  }
  for (const pkg of packages) for (const [name, range] of Object.entries(pkg.requires)) {
    const provision = provisions.get(name);
    if (!provision || !matches(provision.version, range)) return failure('gap', gap(pkg, name, range));
    if (pkg.scope === 'deployment' && provision.scope !== 'deployment') return failure('scope', `${pkg.name} requires ${name} at deployment scope; only person scope exists.`);
    if (byName.has(provision.owner)) graph.get(pkg.name)?.add(provision.owner);
  }
  const result: Package[] = [];
  while (graph.size) {
    const names = [...graph.keys()].filter(name => graph.get(name)?.size === 0).sort();
    if (!names.length) return failure('cycle', `Requirements form a cycle: ${[...graph.keys()].sort().join(', ')}.`);
    for (const name of names) {
      const pkg = byName.get(name); if (!pkg) throw new Error('The resolution graph lost a package.');
      result.push(pkg); graph.delete(name);
      for (const edges of graph.values()) edges.delete(name);
    }
  }
  return { ok: true, value: result };
}

export function envelope(names: readonly string[], patterns: readonly string[]): Result<void, 'envelope'> {
  for (const name of names) {
    if (!patterns.some(pattern => {
      const expression = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('.*');
      return new RegExp(`^${expression}$`, 'u').test(name);
    })) return failure('envelope', `${name} is outside the declared envelope (${patterns.join(', ')}).`);
  }
  return { ok: true, value: undefined };
}
