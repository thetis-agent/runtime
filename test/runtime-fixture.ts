/** Boot reviewed processes through the real runtime and generation driver; KS-004, GN-004. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Runtime } from '../kernel/boundary/runtime.ts';
import type { Target } from '../kernel/boundary/runtime.ts';
import { Identity } from '../kernel/identity/index.ts';
import type { Principal } from '../kernel/identity/index.ts';
import { Journal } from '../kernel/log/index.ts';
import { Schemas } from '../lib/schema/index.ts';
import { ManualClock } from '../lib/events/index.ts';
import { SandboxRunner } from '../lib/sandbox-runner/index.ts';
import type { Mount } from '../lib/sandbox-runner/index.ts';
import { snapshot } from '../lib/snapshots/index.ts';
import { discover } from '../lib/package-loader/index.ts';
import { packagesRoot } from '../lib/profile/packages-root.ts';
import { packageMounts } from './package-mounts.ts';
import type { Revision } from '../kernel/generations/prepare.ts';

const repository = new URL('..', import.meta.url).pathname.replace(/\/$/u, '');
export const people: Principal[] = ['alice', 'bob'].map(id => ({ id, role: 'user', projects: [], observeOthers: false }));
export async function revision(name: string, entry: string, mounts: Mount[] = []): Promise<Revision> {
  const source = join(packagesRoot(repository), name); const hash = await snapshot(source); assert.ok(hash.ok);
  return { plan: { name, version: '1.0.0', entry: join(source, entry), args: [], cwd: '/state', execution: 'artifacts' }, pins: { [name]: { source, hash: hash.value, mount: source } },
    mounts: [...packageMounts(repository, []), ...mounts],
    stateMount: '/state', endpointMount: '/endpoint', socketName: 'service.sock', quotaBytes: 67108864, migrations: [], formats: [], migrate: 'stop' };
}

export async function runtimeFixture() {
  const root = await mkdtemp('/tmp/runtime-'); const schemas = new Schemas(); await schemas.load(); const clock = new ManualClock();
  const journal = await Journal.open(join(root, 'observed.jsonl'), () => clock.now()); assert.ok(journal.ok);
  const identity = new Identity({ people, bindings: [], authorities: {} }, () => clock.now());
  const runtime = new Runtime({ root: join(root, 'targets'), schemas, clock, journal: journal.value, identity, runner: new SandboxRunner('/cgroup') });
  const state = join(root, 'initial'); await mkdir(state);
  const shared: Target = { id: 'shared', owner: '', scope: 'deployment', state, revision: await revision('provider-mock', 'service.ts'), entries: [], services: [],
    profile: { rule: { name: 'cost', cost: 1, requests: 100, windowMs: 86400000 }, settings: {} }, registration: { package: 'provider-mock', id: 'provider' } };
  const started = await runtime.start(shared); assert.ok(started.ok, JSON.stringify(started));
  const service = runtime.endpoint('shared'); assert.ok(service.ok);
  const discovered = await discover(packagesRoot(repository), '/state/packages', {}, schemas); assert.ok(discovered.ok, JSON.stringify(discovered));
  return { root, runtime, identity, schemas, shared, journal: journal.value, clock, async environment(person: string): Promise<Target> {
    const space = join(root, person); await mkdir(space);
    const config: Target = { id: person, owner: person, scope: 'person', state, services: ['shared'], entries: discovered.value.filter(entry => ['core', 'tools-files'].includes(entry.manifest.name)),
      revision: await revision('core', 'main.ts', [{ source: join(packagesRoot(repository), 'tools-files'), path: join(packagesRoot(repository), 'tools-files'), mode: 'ro' },
        { source: space, path: '/space', mode: 'rw', maximumBytes: 67108864 }, { source: 'service:shared', path: '/services/provider', mode: 'ro' }]), profile: {} };
    config.profile = { entries: config.entries, profile: {}, provided: {}, spaces: [], excluded: [], runtime: { root: '/state/conversations', endpoint: '/endpoint/service.sock', providerSocket: '/services/provider/current.sock',
      person, token: 'replaced-by-inherited-authority', model: 'scripted', provider: 'shared', space: '/space', system: [], roots: [{ path: '/space', mode: 'rw', space: 'person' }], mode: { readOnly: false, deny: [] } } };
    return config;
  }, rows: () => readFile(join(root, 'observed.jsonl'), 'utf8'), async close() { const stopped = await runtime.close(); await journal.value.close(); await rm(root, { recursive: true, force: true }); assert.ok(stopped.ok); } };
}
