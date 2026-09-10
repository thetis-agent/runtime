/** Exercise work discovery with real pinned processes and no external provider; implementation note 0045, GN-001. */
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { start } from '@/kernel/main.ts';
import { configuration } from '@/lib/deployment/index.ts';
import { writeDeployment } from '@/lib/profile/orchestrate.ts';
import { catalog } from '@/lib/profile/catalog.ts';
import { packagesRoot } from '@/lib/profile/packages-root.ts';
import { snapshot } from '@/lib/snapshots/index.ts';
import { Schemas } from '@/lib/schema/index.ts';
import type { ConfiguredTarget, Configuration } from '@/lib/deployment/index.ts';
import type { Entry, Registration } from '@/lib/package-loader/types.ts';

export const provision: Registration = { requires: {}, provides: { 'service/dynamic': '1.0.0' } };
export const producerCode = `export const stages = {};
export function init(profile, context) { if (profile.marker !== 'same-profile') throw new Error('Profile changed during capture.'); context.register(${JSON.stringify(provision)}); }
`;
const mount = '/opt/thetis-runtime';
const repository = new URL('..', import.meta.url).pathname.replace(/\/$/u, '');

async function layout(root: string): Promise<string> {
  const path = join(root, 'layout'); await mkdir(join(path, 'packages'), { recursive: true });
  for (const name of ['lib', 'contracts']) await cp(join(repository, name), join(path, name), { recursive: true });
  await cp(join(packagesRoot(repository), 'core'), join(path, 'packages/core'), { recursive: true });
  const sources = await catalog(repository); assert.ok(sources.ok, JSON.stringify(sources));
  for (const source of sources.value.filter(source => source.kind === 'node_modules')) {
    const destination = join(path, 'node_modules', source.directory); await mkdir(join(destination, '..'), { recursive: true });
    await cp(source.source, destination, { recursive: true });
  }
  return path;
}

async function entry(root: string, name: string): Promise<Entry> {
  const manifest: Entry['manifest'] = { name, version: '1.0.0', settings: {}, requires: name === 'consumer' ? { 'service/dynamic': '^1' } : {}, provides: {},
    envelope: { requires: [], provides: name === 'producer' ? ['service/dynamic'] : [], spawn: { scope: 'person', network: 'none' } } };
  const path = join(root, 'packages', name); await mkdir(path);
  await writeFile(join(path, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(path, 'index.ts'), name === 'producer' ? producerCode : 'export const stages = {};\n');
  return { path: `${mount}/packages/${name}/index.ts`, state: `/state/packages/${name}`, settings: {}, manifest };
}

export async function workRegistrationFixture() {
  const root = await mkdtemp('/assembly/w-'); const schemas = new Schemas(); await schemas.load();
  const source = await layout(root); const entries = [await entry(source, 'consumer'), await entry(source, 'producer')];
  const pins: ConfiguredTarget['revision']['pins'] = {};
  const hash = await snapshot(source); assert.ok(hash.ok); pins['layout'] = { source, hash: hash.value, mount };
  for (const entry of entries) {
    const path = join(source, 'packages', entry.manifest.name); const hash = await snapshot(path); assert.ok(hash.ok);
    pins[`alias:/packages/${entry.manifest.name}@1.0.0`] = { source: path, hash: hash.value, mount: `/packages/${entry.manifest.name}@1.0.0` };
  }
  const producer = pins['alias:/packages/producer@1.0.0']; assert.ok(producer);
  const state = join(root, 'initial'); await mkdir(state); await writeFile(join(state, 'private-state'), 'not available to discovery');
  const target: ConfiguredTarget = { id: 'alice', owner: 'alice', scope: 'person', state, entries, services: [], environment: true,
    revision: { plan: { name: 'core', version: '1.0.0', entry: `${mount}/packages/core/main.ts`, args: [], cwd: '/state', execution: 'source' }, pins, mounts: [],
      stateMount: '/state', endpointMount: '/endpoint', socketName: 'service.sock', quotaBytes: 536870912, formats: [], migrations: [], migrate: 'shared' },
    profile: { entries, profile: { marker: 'same-profile' }, provided: {}, spaces: [], excluded: [], registrations: [{ source: 'producer@1.0.0', hash: producer.hash, registration: provision }],
      runtime: { root: '/state/conversations', endpoint: '/endpoint/service.sock', providerSocket: '/unused-provider.sock', person: 'alice', token: 'inherited-at-start',
        model: 'unused', provider: 'unused', space: '/state', system: [], roots: [], mode: { readOnly: false, deny: [] } } } };
  const person = { id: 'alice', role: 'user', projects: [], observeOthers: false } satisfies Configuration['identity']['people'][number];
  const config: Configuration = { version: 1, root: join(root, 'r'), cgroup: '/cgroup', identity: { people: [person], bindings: [], authorities: {} }, targets: [target] };
  const path = join(root, 'configuration.json'); assert.ok((await writeDeployment(path, config)).ok);
  const running = await start(path); assert.ok(running.ok, JSON.stringify(running));
  const work = join(root, 'work'); await mkdir(work);
  for (const entry of entries) await cp(join(source, 'packages', entry.manifest.name), join(work, entry.manifest.name), { recursive: true });
  return { root, schemas, target, config, work, person, runtime: running.value.runtime, setting: { target: 'alice', root: work, cache: join(root, 'staged'), discoveryRoot: join(root, 'd'), discoveryEntry: `${mount}/packages/core/work-discovery.ts` },
    async current(): Promise<ConfiguredTarget> {
      const current = running.value.runtime.current('alice'); assert.ok(current.ok);
      await writeFile(path, JSON.stringify({ ...config, targets: [current.value] }));
      const read = await configuration(path, schemas); assert.ok(read.ok); const target = read.value.targets[0]; assert.ok(target); return target;
    },
    async launch(path: string) {
      const reviewed = await configuration(path, schemas); assert.ok(reviewed.ok, JSON.stringify(reviewed));
      assert.equal(reviewed.value.trusted, undefined); const target = reviewed.value.targets[0]; assert.ok(target);
      assert.notEqual(target.state, state); assert.deepEqual(target.services, []); assert.deepEqual(target.revision.mounts, []); assert.equal(target.revision.plan.network, 'none');
      assert.deepEqual(await readdir(target.state), []);
      return start(path);
    },
    async close() { const closed = await running.value.close(); await rm(root, { recursive: true, force: true }); assert.ok(closed.ok, JSON.stringify(closed)); }
  };
}
