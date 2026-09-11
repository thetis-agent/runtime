/** Mount one person's direct stream beside inherited observed submissions; KS-004, ADR 0019. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Journal } from '@/kernel/log/index.ts';
import { Process } from '@/kernel/boundary/process.ts';
import type { Context } from '@/kernel/boundary/process.ts';
import { sessionWhois } from '@/kernel/boundary/runtime.ts';
import type { Operation } from '@/kernel/socket/index.ts';
import type { Method } from '@/contracts/kernel-socket/types.ts';
import { everyone, listEveryone, sessionMethods } from '@/lib/socket/sessions.ts';
import { SandboxRunner } from '@/lib/sandbox-runner/index.ts';
import type { Mount } from '@/lib/sandbox-runner/index.ts';
import { Schemas, failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import { ManualClock } from '@/lib/events/index.ts';
import type { serviceFixture } from '@/test/provider-service.ts';
import type { environmentProcess } from '@/test/environment-process.ts';
import { packageEntry, packageMounts } from '@/test/package-mounts.ts';

export async function gatewayProcess(shared: Awaited<ReturnType<typeof serviceFixture>>, environment: Awaited<ReturnType<typeof environmentProcess>>, person: string, packageName: string, args: string[] = [], entry = 'service.ts', profile: Record<string, unknown> = {}, siblings: readonly string[] = [], peers: readonly { owner: string; process: { invoke(method: Method, params: Record<string, unknown>): Promise<Result<unknown>> } }[] = []) {
  const root = await mkdtemp('/tmp/gateway-process-'); await mkdir(join(root, 'state')); await mkdir(join(root, 'endpoint'));
  await symlink('service.sock', join(environment.root, 'endpoint/current.sock'));
  const schemas = new Schemas(); await schemas.load(); const clock = new ManualClock();
  const issued = shared.identity.issue({ id: `gateway-${person}`, person, scope: 'person', target: `gateway-${person}`, generation: 1, services: [] }); assert.ok(issued.ok);
  const journal = await Journal.open(join(root, 'rows.jsonl'), () => clock.now()); assert.ok(journal.ok);
  /* The kernel's own routing rule, in the two lines kernel/boundary/runtime.ts spends on it: only
   * `session.list` may name a person other than the caller, and `*` means every running environment,
   * each asked under its own name and its rows stamped with whose they are. A fixture that shortcut
   * this answered an everyone-scoped list with one person's unstamped rows, which is indistinguishable
   * on the wire from a deployment where nobody else exists — so the surface's own everyone view could
   * never be looked at. `peers` are the other environments this deployment is running; a caller that
   * names none keeps the single-environment behaviour every other test here relies on. */
  const environments = [{ owner: person, invoke: environment.process.invoke.bind(environment.process) },
    ...peers.map(peer => ({ owner: peer.owner, invoke: peer.process.invoke.bind(peer.process) }))];
  const methods = new Map<Method, Operation>(sessionMethods.filter(method => method !== 'session.subscribe').map(method => [method, (run, params) => {
    assert.equal(run.person, person);
    const requested = method === 'session.list' && typeof params['person'] === 'string' ? params['person'] : person;
    if (requested === everyone) return listEveryone(environments.map(value => ({ owner: value.owner, list: args => value.invoke('session.list', args) })), params);
    const target = environments.find(value => value.owner === requested);
    return target ? target.invoke(method, params) : Promise.resolve(failure('not-found', 'The person has no running environment.'));
  }]));
  methods.set('health.probe', () => Promise.resolve({ ok: true, value: { ready: true } }));
  // The target's profile is the only thing a deployment gets to configure about a spawned gateway, so a
  // test that wants a differently-configured one supplies it here rather than editing a committed recipe.
  methods.set('profile.get', () => Promise.resolve({ ok: true, value: { person, ...profile } }));
  methods.set('session.whois', (run, params) => Promise.resolve(sessionWhois(shared.identity, run, params['sessionToken'])));
  methods.set('env.status', run => Promise.resolve({ ok: true, value: { person: run.person, state: 'LIVE' } }));
  // The observed-journal tail the web gateway's status bar reads. The limit is echoed back so a test
  // can see that the bound the gateway puts on the ask actually reached the kernel.
  methods.set('env.logs', (run, params) => Promise.resolve({ ok: true, value: { target: run.person, cursor: 1, oldest: 1, truncated: false,
    rows: [{ cursor: 1, at: 1700000000000, kind: 'process.start', data: { limit: params['limit'] } }] } }));
  methods.set('env.reset', run => Promise.resolve({ ok: true, value: { person: run.person, state: 'LIVE' } }));
  const context: Context = { target: `gateway-${person}`, identity: shared.identity, schemas, clock, journal: journal.value, runner: new SandboxRunner('/cgroup'), operations: { methods, notes: ['run.stop', 'env.updated'], note: () => Promise.resolve({ ok: true, value: undefined }) } };
  const repository = new URL('..', import.meta.url).pathname.replace(/\/$/u, '');
  const started = await Process.start({ name: 'fixture', version: '1.0.0', entry: packageEntry(repository, packageName, entry), args, cwd: '/state', mounts: [
    // Siblings are mounted beside the gateway at their own paths, which is the layout panels.ts
    // reads: a contributed panel is discovered by readdir, so a fixture that names none has none.
    ...packageMounts(repository, [packageName, ...siblings]),
    { source: join(environment.root, 'endpoint'), path: '/services/environment', mode: 'ro' },
    ...['state', 'endpoint'].map((name): Mount => ({ source: join(root, name), path: `/${name}`, mode: 'rw', maximumBytes: 67108864 }))
  ] }, issued.value, context); assert.ok(started.ok, JSON.stringify(started));
  return { root, process: started.value, socket: join(root, 'endpoint/service.sock'), rows: () => readFile(join(root, 'rows.jsonl'), 'utf8'), async close() {
    assert.ok((await started.value.stop('test complete')).ok); await journal.value.close(); await rm(root, { recursive: true, force: true });
  } };
}
