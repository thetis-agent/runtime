/** Review a bootstrap seed, then exercise only registry-delivered process generations; KS-009, GN-002. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { start } from '../kernel/main.ts';
import { Schemas } from '../lib/schema/index.ts';
import { catalog } from '../lib/profile/catalog.ts';
import { materialize } from '../lib/profile/index.ts';
import { target } from '../lib/profile/target.ts';
import { snapshot } from '../lib/snapshots/index.ts';
import { git } from '../lib/registry/git.ts';
import { describe } from '../lib/package-loader/discovery-client.ts';
import { validator } from '../lib/profile/schema.ts';
import { assembleDeployment, writeDeployment } from '../lib/profile/orchestrate.ts';
import { credential } from '../packages/gateway-login/password.ts';
import type { Layer, Recipe } from '../lib/profile/types.ts';
import type { Deployment, Target, Principal } from '../lib/deployment/types.ts';
import type { Accounts, Credential } from '../packages/gateway-login/types.ts';

/** The recipe never carries real credentials (they would ship in the repo); the operator populates
 * this state directory at deploy time via `packages/gateway-login/password.ts:credential`, as documented
 * in `docs/headless-startup.md`'s "Password authority and trusted kernel origin" section. Tests stand in
 * for that operator step with a fixed password so assembly and startup can be exercised offline. */
const loginPasswords = { 'alice-login': 'Alice test password', 'bob-login': 'Bob test password' };
const repository = new URL('..', import.meta.url).pathname.replace(/\/$/u, '');
export const principals: Principal[] = ['alice', 'bob'].map(id => ({ id, role: 'user', projects: [], observeOthers: false }));
const identity = { people: principals, bindings: [], authorities: {} };

async function seed(root: string, schemas: Schemas): Promise<Target> {
  const sources = await catalog(repository); assert.ok(sources.ok); const layers: Layer[] = [];
  for (const source of sources.value.filter(source => source.kind !== 'packages' || source.name === 'registries')) {
    const reviewed = join(root, 'review', source.kind, source.directory); await mkdir(join(reviewed, '..'), { recursive: true }); const hash = await snapshot(source.source, reviewed); assert.ok(hash.ok, JSON.stringify(hash)); const version = source.manifest['version']; assert.ok(typeof version === 'string');
    layers.push({ ...source, source: reviewed, pin: { name: source.name, version, hash: hash.value, commit: '0'.repeat(40) } });
  }
  const installed = await materialize(layers, join(root, 'seed'), schemas); assert.ok(installed.ok, JSON.stringify(installed));
  const planned = await target(installed.value, { id: 'registry', quotaBytes: 536870912, owner: '', scope: 'deployment', state: join(root, 'state'), package: 'registries', entry: 'service.ts',
    profile: { registry: '/registry', cache: '/cache', sources: ['/sources/repository'] }, mounts: [
      { source: join(root, 'registry'), path: '/registry', mode: 'rw', maximumBytes: 536870912 },
      { source: join(root, 'cache'), path: '/cache', mode: 'rw', maximumBytes: 536870912 },
      { source: repository, path: '/sources/repository', mode: 'ro' } ] }, schemas);
  assert.ok(planned.ok, JSON.stringify(planned)); return planned.value;
}
export async function fixture() {
  const root = await mkdtemp('/assembly/da-'); const schemas = new Schemas(); await schemas.load();
  for (const name of ['cache', 'state', 'output']) await mkdir(join(root, name));
  const initialized = await git(join(root, 'registry'), ['init', '--bare']); assert.ok(initialized.ok);
  const initial: Deployment = { version: 1, root: join(root, 's'), cgroup: '/cgroup', identity, targets: [await seed(root, schemas)] };
  const path = join(root, 'seed.json'); assert.ok((await writeDeployment(path, initial)).ok); const running = await start(path); assert.ok(running.ok, JSON.stringify(running));
  const endpoint = running.value.runtime.endpoint('registry'); assert.ok(endpoint.ok);
  return { root, schemas, services: { registry: endpoint.value, cache: join(root, 'cache'), async describe(target: Target) {
    const path = join(root, 'discovery.json'); const configuration: Deployment = { version: 1, root: join(root, 'd'), cgroup: '/cgroup', identity, targets: [target] };
    assert.ok((await writeDeployment(path, configuration)).ok); const process = await start(path); assert.ok(process.ok, JSON.stringify(process));
    try { const endpoint = process.value.runtime.endpoint(target.id); assert.ok(endpoint.ok); return await describe(endpoint.value, schemas); }
    finally { assert.ok((await process.value.close()).ok); }
  } }, async close() { const events: string[] = []; for (const name of await readdir('/cgroup')) if (name.startsWith('run-')) events.push(await readFile(join('/cgroup', name, 'memory.events'), 'utf8') + await readFile(join('/cgroup', name, 'memory.stat'), 'utf8')); assert.ok((await running.value.close()).ok); await rm(root, { recursive: true, force: true }); assert.ok(events.every(value => value.includes('oom_kill 0\n')), events.join('\n')); } };
}
export async function recipe(root: string): Promise<Recipe> {
  const bytes = await readFile(new URL('../profiles/examples/two-account.recipe.json', import.meta.url), 'utf8');
  const input: unknown = JSON.parse(bytes.replaceAll('/var/lib/thetis/kernel', join(root, 'r')).replaceAll('/var/lib/thetis/initial', join(root, 'state')).replaceAll('/var/lib/thetis/spaces/', `${root}/`).replaceAll('/var/lib/thetis', root).replaceAll('/sys/fs/cgroup/thetis', '/cgroup'));
  const schemas = new Schemas(); await schemas.load(); assert.ok((await validator<Recipe>(schemas, 'recipe'))(input));
  for (const person of principals) await mkdir(join(root, person.id));
  await mkdir(join(root, 'login-state'));
  const accounts: Credential[] = [];
  for (const [id, password] of Object.entries(loginPasswords)) { const hashed = await credential(id, password); assert.ok(hashed.ok, JSON.stringify(hashed)); accounts.push(hashed.value); }
  const state: Accounts = { version: 1, accounts };
  await writeFile(join(root, 'login-state', 'accounts.json'), JSON.stringify(state));
  return input;
}
/** Assemble and start the two-account recipe against a fixture, optionally customizing the plan
 * first; shared by KS-009 (which scripts the provider before assembling) and KS-024 (which only
 * needs a running gateway target) so neither test's body carries the other's setup. */
export async function deployed(environment: Awaited<ReturnType<typeof fixture>>, customize: (plan: Recipe) => void = () => undefined) {
  const plan = await recipe(environment.root); customize(plan);
  const assembled = await assembleDeployment(plan, environment.services, environment.schemas); assert.ok(assembled.ok, JSON.stringify(assembled));
  const path = join(environment.root, 'deployment.json'); assert.ok((await writeDeployment(path, assembled.value.deployment)).ok);
  const running = await start(path); assert.ok(running.ok, JSON.stringify(running));
  return { plan, deployment: assembled.value.deployment, path, running: running.value };
}
