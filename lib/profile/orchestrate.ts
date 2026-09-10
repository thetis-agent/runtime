/** Assemble only explicitly selected immutable layers and captured spawns; KS-009, GN-002, ADR 0017. */
import { validators } from '../evaluation/index.ts';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { call } from '../registry/client.ts';
import { failure, isObject } from '../schema/index.ts';
import type { Result, Schemas } from '../schema/index.ts';
import type { Captured } from '../package-loader/types.ts';
import type { Deployment, Target } from '../deployment/types.ts';
import { clock } from '../events/index.ts';
import { atomicWrite } from '../files/atomic.ts';
import { cache } from './cache.ts';
import { target } from './target.ts';
import { validator } from './schema.ts';
import type { Recipe, Process, Profile, Install } from './types.ts';
export interface Services { registry: string; cache: string; describe(target: Target): Promise<Result<Captured>> }

async function install(profile: Profile, names: readonly string[], services: Services, schemas: Schemas): Promise<Result<Install>> {
  if (new Set(names).size !== names.length || names.some(name => !profile.pins.some(layer => layer.pin.name === name))) return failure('not-found', 'The selected immutable package is absent from the profile.');
  const selected = new Set(names); const layers = profile.pins.filter(layer => selected.has(layer.pin.name));
  const reply = await call(services.registry, { v: '1', id: randomUUID(), method: 'assemble', layers }, schemas, clock, 600000);
  return reply.ok ? cache(reply.value, services.cache, schemas) : reply;
}
async function planned(profile: Profile, process: Process, services: Services, schemas: Schemas, captured?: Captured): Promise<Result<Target>> {
  const installed = await install(profile, process.selection, services, schemas); if (!installed.ok) return installed;
  const pkg = installed.value.packages.find(pkg => pkg.name === process.package);
  const registration = pkg ? captured?.registrations.find(record => record.source === `${pkg.name}@${pkg.version}`) : undefined;
  if (process.spawn && !registration) return failure('envelope', 'The selected process has no captured package registration.');
  const built = await target(installed.value, { ...process, ...(process.spawn && registration ? { captured: { ...registration, id: process.spawn } } : {}) }, schemas);
  if (built.ok && captured) built.value.profile['registrations'] = captured.registrations.flatMap(record => {
    const pkg = installed.value.packages.find(pkg => `${pkg.name}@${pkg.version}` === record.source);
    const pin = pkg ? installed.value.aliases.find(pin => pin.mount === `/packages/${pkg.name}@${pkg.version}`) : undefined;
    return pin ? [{ ...record, hash: pin.hash }] : [];
  });
  return built;
}
export async function assembleDeployment(input: unknown, services: Services, schemas: Schemas): Promise<Result<{ deployment: Deployment; profile: Profile }>> {
  if (!(await validator<Recipe>(schemas, 'recipe'))(input)) return failure('invalid-args', 'The deployment recipe violates its schema.');
  const published = await call(services.registry, { v: '1', id: randomUUID(), method: 'bootstrap', source: input.source, at: input.at }, schemas, clock, 600000);
  if (!published.ok) return published;
  if (!isObject(published.value) || !(await validator<Profile>(schemas, 'profile'))(published.value['profile'])) return failure('invalid-args', 'The registry returned an invalid pinned profile.');
  const profile = published.value['profile']; const probe = await planned(profile, input.discovery, services, schemas); if (!probe.ok) return probe;
  probe.value.profile = { roots: ['/opt/thetis-runtime'], state: '/state', setup: { entries: probe.value.entries, profile: {}, provided: {}, spaces: [], excluded: [] } };
  const captured = await services.describe(probe.value); if (!captured.ok) return captured;
  if (captured.value.failures.length || captured.value.gaps.length) return failure('envelope', `The selected discovery profile has unmet requirements: ${captured.value.gaps.join(' ')}`);
  const targets: Target[] = [];
  for (const process of input.targets) { const assembled = await planned(profile, process, services, schemas, captured.value); if (!assembled.ok) return assembled; targets.push(assembled.value); }
  const deployment = { version: 1, root: input.root, cgroup: input.cgroup, identity: input.identity, targets };
  const raw: unknown = JSON.parse(await readFile(new URL('../deployment/schema.json', import.meta.url), 'utf8'));
  if (!isObject(raw)) throw new Error('The committed deployment schema is invalid.');
  validators(schemas);
  return schemas.compile<Deployment>(raw)(deployment) ? { ok: true, value: { deployment, profile } } : failure('invalid-args', 'The assembled deployment violates its schema.');
}
export async function writeDeployment(path: string, deployment: Deployment): Promise<Result<void>> {
  const bytes = Buffer.from(`${JSON.stringify(deployment, null, 2)}\n`);
  return bytes.length <= 1048576 ? atomicWrite(path, bytes) : failure('budget', 'The deployment configuration exceeds its byte limit.');
}
