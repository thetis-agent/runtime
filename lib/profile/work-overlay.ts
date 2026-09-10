/** Overlay hashed work trees without rewriting immutable release sources; GN-001–002, KS-009. */
import { dirname, join } from 'node:path';
import { readBounded } from '@/lib/files/read-bounded.ts';
import { validator } from '@/lib/package-loader/index.ts';
import type { Manifest, Entry, Captured, Registration, Recorded } from '@/lib/package-loader/types.ts';
import { Register } from '@/lib/package-loader/registration.ts';
import { recorded, pinHash } from '@/lib/package-loader/requirements.ts';
import { compose } from '@/lib/package-loader/composition.ts';
import { configured } from '@/lib/schema/settings.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Result, Schemas } from '@/lib/schema/index.ts';
import { resolve, matches } from '@/lib/semver-match/index.ts';
import type { Provision } from '@/lib/semver-match/index.ts';
import type { ConfiguredTarget } from '@/lib/deployment/index.ts';
import type { Work } from './work.ts';

async function manifest(source: string, schemas: Schemas): Promise<Result<Manifest>> {
  const read = await readBounded(join(source, 'package.json'), 65536); if (!read.ok) return read;
  let value: unknown; try { value = JSON.parse(read.value.toString('utf8')); } catch { return failure('invalid-args', 'The work manifest is not valid JSON.'); }
  return (await validator<Manifest>(schemas, 'manifest'))(value) && matches(value.version, '*') ? { ok: true, value } : failure('invalid-args', 'The work manifest violates its schema.');
}
export async function overlay(current: ConfiguredTarget, changes: readonly Work[], schemas: Schemas): Promise<Result<ConfiguredTarget>> {
  if (current.scope !== 'person' || current.environment === false) return failure('forbidden', 'Work edits require a person-owned environment.');
  const selected: Entry[] = current.entries;
  const target = { ...structuredClone(current), entries: structuredClone(selected) };
  for (const change of changes) {
    const entry = target.entries.find(entry => entry.manifest.name === change.name); if (!entry) return failure('not-found', 'The work package is absent from the selected environment.');
    const next = await manifest(change.source, schemas); if (!next.ok) return next;
    if (next.value.name !== change.name) return failure('invalid-args', 'The work manifest names a different package.');
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) if (isObject(next.value[key]) && Object.keys(next.value[key]).length) return failure('forbidden', 'The work package contains external dependencies.');
    const settings = configured(next.value.settings, entry.settings); if (!schemas.arguments(next.value.settings, settings)) return failure('invalid-args', 'The work settings violate the edited manifest schema.');
    const alias = `/packages/${entry.manifest.name}@${entry.manifest.version}`;
    target.revision.pins = Object.fromEntries(Object.entries(target.revision.pins).filter(([, pin]) => pin.mount !== alias));
    target.revision.pins[`work:${change.name}`] = { source: change.source, hash: change.hash, mount: dirname(entry.path) };
    target.revision.pins[`alias:/packages/${next.value.name}@${next.value.version}`] = { source: change.source, hash: change.hash, mount: `/packages/${next.value.name}@${next.value.version}` };
    entry.manifest = next.value; entry.settings = settings;
  }
  target.profile['entries'] = target.entries;
  const runtime = target.profile['runtime'];
  if (!isObject(runtime)) return failure('invalid-args', 'The work environment has no runtime profile.');
  runtime['requiredSources'] = target.entries.filter(entry => changes.some(change => change.name === entry.manifest.name)).map(entry => `${entry.manifest.name}@${entry.manifest.version}`);
  return { ok: true, value: target };
}
export async function facts(target: ConfiguredTarget, schemas: Schemas): Promise<Result<Provision[]>> {
  const selected: Entry[] = target.entries;
  const result: Provision[] = []; const entries = new Set(selected.map(entry => entry.manifest.name));
  for (const pin of Object.values(target.revision.pins)) {
    if (!pin.mount.startsWith('/packages/')) continue;
    const value = await manifest(pin.source, schemas); if (!value.ok) return value; if (entries.has(value.value.name)) continue;
    for (const [name, version] of Object.entries({ [value.value.name]: value.value.version, ...value.value.provides })) result.push({ name, version, scope: 'deployment', owner: value.value.name });
  }
  const provided = target.profile['provided'];
  if (isObject(provided)) for (const [name, value] of Object.entries(provided)) {
    if (!isObject(value) || typeof value['version'] !== 'string' || !matches(value['version'], '*')) return failure('invalid-args', 'The provided work requirement has no valid version.');
    result.push({ name, version: value['version'], scope: target.scope, owner: 'kernel' });
  }
  return { ok: true, value: result };
}
export async function matched(target: ConfiguredTarget, supplied: readonly Provision[], captured: Captured | undefined, schemas: Schemas): Promise<Result<void>> {
  const retained = captured ? await registrations(target, captured, schemas) : await recorded(target.entries, target.profile, target.revision.pins, schemas); if (!retained.ok) return retained;
  const packages = compose(target.entries, target.scope, retained.value);
  const resolved = resolve(packages, supplied); return resolved.ok ? { ok: true, value: undefined } : resolved;
}

async function registrations(target: ConfiguredTarget, captured: Captured, schemas: Schemas): Promise<Result<Recorded>> {
  if (captured.failures.length || captured.gaps.length) return failure('envelope', captured.gaps.join(' ') || captured.failures[0]?.message || 'The work package failed to initialize.');
  const entries: Entry[] = target.entries;
  const sources = new Set(captured.sources); const selected = new Map(entries.map(entry => [`${entry.manifest.name}@${entry.manifest.version}`, entry]));
  if (sources.size !== captured.sources.length || sources.size !== selected.size || [...sources].some(source => !selected.has(source))) return failure('envelope', 'The work probe did not initialize exactly the selected packages.');
  const check = await validator<Registration>(schemas, 'registration'); const records: Recorded = []; const registered = new Set<string>();
  for (const record of captured.registrations) {
    const entry = selected.get(record.source); if (!entry) return failure('envelope', 'The work probe registered an unselected package.');
    if (registered.has(record.source)) return failure('collision', 'The work probe repeated a package registration.'); registered.add(record.source);
    const checked = new Register(entry, check).register(record.registration); if (!checked.ok) return checked;
    const hash = pinHash(entry, target.revision.pins); if (!hash) return failure('envelope', 'The work probe registration has no candidate pin.');
    records.push({ source: record.source, hash, registration: structuredClone(record.registration) });
  }
  return { ok: true, value: records };
}

export async function capturedTarget(target: ConfiguredTarget, captured: Captured, supplied: readonly Provision[], schemas: Schemas): Promise<Result<ConfiguredTarget>> {
  const accepted = await registrations(target, captured, schemas); if (!accepted.ok) return accepted;
  const resolved = resolve(compose(target.entries, target.scope, accepted.value), supplied); if (!resolved.ok) return resolved;
  return { ok: true, value: { ...target, profile: { ...target.profile, registrations: accepted.value } } };
}
