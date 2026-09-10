/** Admit concrete requirements only from recorded pins and inherited profile facts; KS-009, ADR 0016. */
import type { Entry, Registration, Recorded } from './types.ts';
import type { Schemas, Result } from '@/lib/schema/index.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import { resolve, matches } from '@/lib/semver-match/index.ts';
import type { Provision } from '@/lib/semver-match/index.ts';
import { validator } from './index.ts';
import { Register } from './registration.ts';
import { compose } from './composition.ts';
export type Pins = Readonly<Record<string, { hash: string; mount: string }>>;
export function pinHash(entry: Entry, pins: Pins): string | undefined {
  const values = Object.values(pins); const alias = values.find(pin => pin.mount === `/packages/${entry.manifest.name}@${entry.manifest.version}`);
  return alias?.hash ?? values.filter(pin => entry.path.startsWith(`${pin.mount}/`)).sort((left, right) => right.mount.length - left.mount.length)[0]?.hash;
}
function facts(entries: readonly Entry[], scope: 'person' | 'deployment', profile: Record<string, unknown>, pins: Pins): Result<Provision[]> {
  const selected = new Set(entries.map(entry => entry.manifest.name)); const result: Provision[] = [];
  for (const pin of Object.values(pins)) {
    if (!pin.mount.startsWith('/packages/')) continue;
    const alias = pin.mount.slice('/packages/'.length); const at = alias.lastIndexOf('@'); const name = alias.slice(0, at); const version = alias.slice(at + 1);
    if (at < 1 || !matches(version, '*')) return failure('invalid-args', 'The recorded package alias has no valid version.');
    if (!selected.has(name)) result.push({ name, version, owner: name, scope: 'deployment' });
  }
  const supplied = profile['provided'];
  if (supplied !== undefined && !isObject(supplied)) return failure('invalid-args', 'The inherited requirement facts violate their shape.');
  for (const [name, value] of Object.entries(supplied ?? {})) {
    if (!isObject(value) || typeof value['version'] !== 'string' || !matches(value['version'], '*')) return failure('invalid-args', 'The inherited requirement fact has no valid version.');
    result.push({ name, version: value['version'], owner: 'kernel', scope: value['scope'] === 'deployment' ? 'deployment' : value['scope'] === 'person' ? 'person' : scope });
  }
  return { ok: true, value: result };
}
export async function recorded(entries: readonly Entry[], profile: Record<string, unknown>, pins: Pins, schemas: Schemas): Promise<Result<Recorded>> {
  const input = profile['registrations'] ?? [];
  if (!(await validator<Recorded>(schemas, 'recorded'))(input)) return failure('invalid-args', 'The recorded registration set violates its schema.');
  const records: Recorded = []; const sources = new Set<string>(); const check = await validator<Registration>(schemas, 'registration');
  for (const record of input) {
    if (sources.has(record.source)) return failure('collision', 'The profile repeats a captured registration source.'); sources.add(record.source);
    const entry = entries.find(entry => `${entry.manifest.name}@${entry.manifest.version}` === record.source);
    if (!entry || pinHash(entry, pins) !== record.hash) continue;
    const checked = new Register(entry, check).register(record.registration); if (!checked.ok) return checked; records.push(record);
  }
  return { ok: true, value: records };
}
export async function requirements(entries: readonly Entry[], scope: 'person' | 'deployment', profile: Record<string, unknown>, pins: Pins, entry: Entry, actual: Registration, schemas: Schemas): Promise<Result<Recorded>> {
  const known = await recorded(entries, profile, pins, schemas); if (!known.ok) return known;
  const source = `${entry.manifest.name}@${entry.manifest.version}`; const hash = pinHash(entry, pins);
  const records = known.value.filter(record => record.source !== source);
  if (hash) records.push({ source, hash, registration: actual });
  const provided = facts(entries, scope, profile, pins); if (!provided.ok) return provided;
  const packages = compose(entries, scope, [...records.filter(record => record.source !== source), { source, registration: actual }]);
  const matched = resolve(packages, provided.value); return matched.ok ? { ok: true, value: records } : matched;
}
