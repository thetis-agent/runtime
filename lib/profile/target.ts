/** Translate captured declarations into neutral immutable process plans; KS-009, GN-002, ADR 0017. */
import { realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { validator } from '../package-loader/index.ts';
import { Register } from '../package-loader/registration.ts';
import type { Entry, Manifest, Registration, Spawn } from '../package-loader/types.ts';
import { configured } from '../schema/settings.ts';
import { failure } from '../schema/index.ts';
import type { Result, Schemas } from '../schema/index.ts';
import type { Target, Mount } from '../deployment/types.ts';
import type { Install } from './types.ts';
export interface Options {
  id: string; owner: string; scope: 'person' | 'deployment'; state: string;
  package: string; entry: string; args?: string[]; profile: Record<string, unknown>;
  settings?: Readonly<Record<string, Record<string, unknown>>>; services?: { id: string; mount: string }[];
  mounts?: Mount[]; environment?: boolean; quotaBytes?: number;
  captured?: { source: string; registration: Registration; id: string };
}
async function entries(install: Install, options: Options, schemas: Schemas): Promise<Result<Entry[]>> {
  const validate = await validator<Manifest>(schemas, 'manifest'); const result: Entry[] = [];
  for (const pkg of install.packages) {
    if (!validate(pkg.manifest)) return failure('invalid-args', 'The installed manifest does not match the package contract.');
    const settings = configured(pkg.manifest.settings, options.settings?.[pkg.name] ?? {});
    if (!schemas.arguments(pkg.manifest.settings, settings)) return failure('invalid-args', 'The target settings do not match the installed package schema.');
    result.push({ path: pkg.entry, manifest: pkg.manifest, settings, state: `/state/packages/${createHash('sha256').update(pkg.name).digest('hex')}` });
  }
  return { ok: true, value: result };
}
async function declaration(entry: Entry, options: Options, schemas: Schemas): Promise<Result<Spawn | undefined>> {
  if (!options.captured) return { ok: true, value: undefined };
  if (options.captured.source !== `${entry.manifest.name}@${entry.manifest.version}`) return failure('invalid-args', 'The registration belongs to a different package version.');
  const check = await validator<Registration>(schemas, 'registration'); const registration = new Register(entry, check);
  const accepted = registration.register(options.captured.registration); if (!accepted.ok) return accepted;
  const captured = registration.finish(undefined); if (!captured.ok) return captured;
  const spawn = captured.value?.spawn?.find(spawn => spawn.id === options.captured?.id);
  return spawn && spawn.scope === options.scope && spawn.cmd === 'node' ? { ok: true, value: spawn } : failure('invalid-args', 'The captured spawn is absent or incompatible with this process target.');
}
export async function target(install: Install, options: Options, schemas: Schemas): Promise<Result<Target>> {
  try {
    const loaded = await entries(install, options, schemas); if (!loaded.ok) return loaded;
    const entry = loaded.value.find(entry => entry.manifest.name === options.package); if (!entry) return failure('invalid-args', 'The process package is absent from its selected profile.');
    const spawn = await declaration(entry, options, schemas); if (!spawn.ok) return spawn;
    const base = entry.path.slice(0, -'index.ts'.length); const executable = join(base, options.entry);
    if (!executable.startsWith(base)) return failure('outside-roots', 'The process entry is outside its selected package.');
    const host = join(install.source, relative(install.mount, executable)); if (await realpath(host) !== host) return failure('outside-roots', 'The process entry is not a canonical reviewed file.');
    const args = options.args ?? [];
    if (spawn.value && (spawn.value.args?.[0] !== executable || JSON.stringify(spawn.value.args.slice(1)) !== JSON.stringify(args))) return failure('invalid-args', 'The process arguments differ from the captured declaration.');
    const services = options.services ?? [];
    return { ok: true, value: { id: options.id, owner: options.owner, scope: options.scope, state: options.state, profile: options.environment ? { ...options.profile, entries: loaded.value } : options.profile, entries: loaded.value, services: services.map(service => service.id), environment: options.environment ?? false,
      ...(spawn.value ? { registration: { package: options.package, id: spawn.value.id, declared: spawn.value, requires: options.captured?.registration.requires, provides: options.captured?.registration.provides } } : {}),
      revision: { plan: { name: entry.manifest.name, version: entry.manifest.version, entry: executable, args, cwd: '/state', network: spawn.value?.network === 'egress' ? 'egress' : 'none', execution: 'artifacts' },
        pins: { layout: { source: install.source, hash: install.hash, mount: install.mount }, ...Object.fromEntries(install.aliases.map(alias => [`alias:${alias.mount}`, alias])) },
        mounts: [...options.mounts ?? [], ...services.map(service => ({ source: `service:${service.id}`, path: service.mount, mode: 'ro' } satisfies Mount))],
        stateMount: '/state', endpointMount: '/endpoint', socketName: 'service.sock', quotaBytes: options.quotaBytes ?? 67108864, formats: [], migrations: [], migrate: 'shared' }
    } };
  } catch { return failure('io', 'The immutable process target could not be assembled.'); }
}
