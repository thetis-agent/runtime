/** Delegate review execution through injected generation launchers, never host imports; KS-009, GN-002. */
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { atomicWrite } from '../files/atomic.ts';
import { readBounded } from '../files/read-bounded.ts';
import { assembleDeployment, writeDeployment } from '../profile/orchestrate.ts';
import { writeProfile } from '../profile/bootstrap.ts';
import { validator } from '../profile/schema.ts';
import type { Recipe } from '../profile/types.ts';
import { describe } from '../package-loader/discovery-client.ts';
import type { Captured } from '../package-loader/types.ts';
import type { Result, Schemas } from '../schema/index.ts';
import { failure } from '../schema/index.ts';
import type { Deployment, Target, Bootstrap } from './types.ts';
export interface Endpoint { endpoint(id: string): Result<string> }
export interface Started { runtime: Endpoint; close(): Promise<Result<void>> }
export type Launch = (configuration: string) => Promise<Result<Started>>;
export type BootstrapSettings = Bootstrap;

async function discovery(target: Target, recipe: Recipe, settings: BootstrapSettings, launch: Launch, schemas: Schemas): Promise<Result<Captured>> {
  const path = join(settings.discoveryRoot, 'configuration.json');
  const input = { version: 1, root: settings.discoveryRoot, cgroup: recipe.cgroup, identity: recipe.identity, targets: [target] };
  const bytes = Buffer.from(`${JSON.stringify(input)}\n`);
  const written = await atomicWrite(path, bytes); if (!written.ok) return written;
  const started = await launch(path); if (!started.ok) return started;
  let result: Result<Captured> = failure('io', 'The discovery generation did not return a result.');
  let closed: Result<void>;
  try { const endpoint = started.value.runtime.endpoint(target.id); result = endpoint.ok ? await describe(endpoint.value, schemas) : endpoint; }
  finally { closed = await started.value.close(); }
  return closed.ok ? result : closed;
}
export async function bootstrap(settings: BootstrapSettings, active: Endpoint, launch: Launch, schemas: Schemas): Promise<Result<Deployment>> {
  const read = await readBounded(settings.recipe, 1048576); if (!read.ok) return read;
  let recipe: unknown;
  try { recipe = JSON.parse(read.value.toString('utf8')); } catch { return failure('invalid-args', 'The bootstrap recipe is not valid JSON.'); }
  if (!(await validator<Recipe>(schemas, 'recipe'))(recipe)) return failure('invalid-args', 'The bootstrap recipe violates its schema.');
  const input = recipe; const registry = active.endpoint(settings.registry); if (!registry.ok) return registry;
  await mkdir(settings.discoveryRoot, { recursive: true, mode: 0o700 });
  const assembled = await assembleDeployment(input, { registry: registry.value, cache: settings.cache, describe: target => discovery(target, input, settings, launch, schemas) }, schemas);
  if (!assembled.ok) return assembled;
  const pinned = await writeProfile(assembled.value.profile, settings.profile); if (!pinned.ok) return pinned;
  const written = await writeDeployment(settings.output, assembled.value.deployment);
  return written.ok ? { ok: true, value: assembled.value.deployment } : written;
}
