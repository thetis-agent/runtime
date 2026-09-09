/** Start the shipped monitor in a real per-person sandbox with a mounted shared service; KS-001, KS-004. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Process } from '../kernel/boundary/process.ts';
import type { Context } from '../kernel/boundary/process.ts';
import type { Operation } from '../kernel/socket/index.ts';
import { Journal } from '../kernel/log/index.ts';
import { Schemas, failure } from '../lib/schema/index.ts';
import { ManualClock } from '../lib/events/index.ts';
import { SandboxRunner } from '../lib/sandbox-runner/index.ts';
import type { Mount } from '../lib/sandbox-runner/index.ts';
import { discover } from '../lib/package-loader/index.ts';
import { sessionMethods } from '../packages/core/protocol.ts';
import type { Method } from '../contracts/kernel-socket/types.ts';
import type { serviceFixture } from './provider-service.ts';

export async function environmentProcess(shared: Awaited<ReturnType<typeof serviceFixture>>, person: string) {
  const root = await mkdtemp('/tmp/person-environment-'); const schemas = new Schemas(); await schemas.load(); const clock = new ManualClock();
  await mkdir(join(root, 'state')); await mkdir(join(root, 'space'));
  const journal = await Journal.open(join(root, 'observed.jsonl'), () => clock.now()); assert.ok(journal.ok);
  const repository = new URL('..', import.meta.url).pathname.replace(/\/$/u, '');
  const entries = await discover(join(repository, 'packages'), '/state/packages', {}, schemas); assert.ok(entries.ok);
  const profile = { entries: entries.value.filter(entry => ['core', 'tools-files'].includes(entry.manifest.name)), profile: {}, provided: {}, spaces: [], excluded: [], runtime: {
    root: '/state/conversations', providerSocket: '/services/provider.sock', person: 'wrong-person', token: 'not-the-inherited-token', model: 'scripted', provider: 'shared', space: '/space',
    system: [{ role: 'system', source: 'core', content: [{ type: 'text', text: 'A stable stored prefix. '.repeat(1024) }] }],
    roots: [{ path: '/space', mode: 'rw', space: 'person' }], mode: { readOnly: false, deny: [] }
  } };
  const operations = new Map<Method, Operation>(sessionMethods.map(method => [method, () => Promise.resolve(failure('forbidden', 'The environment cannot route its own upstream session calls.'))]));
  operations.set('health.probe', () => Promise.resolve({ ok: true, value: { ready: true } }));
  operations.set('profile.get', () => Promise.resolve({ ok: true, value: profile }));
  const context: Context = { target: person, identity: shared.identity, schemas, clock, journal: journal.value, runner: new SandboxRunner('/cgroup'), operations: {
    methods: operations, notes: ['run.stop', 'env.updated', 'notice', 'turn.report'],
    note: (run, note) => note.note === 'notice' || note.note === 'turn.report' ? journal.value.reported(run.target, note.note, note.params) : Promise.resolve(failure('forbidden', 'Only the kernel sends environment control notes.'))
  } };
  const caller = shared.client(person);
  const started = await Process.start({ name: 'fixture', version: '1.0.0', entry: `${repository}/packages/core/main.ts`, args: [], cwd: '/state', mounts: [
    ...['lib', 'contracts', 'node_modules', 'packages/core', 'packages/tools-files'].map((name): Mount => ({ source: `${repository}/${name}`, path: `${repository}/${name}`, mode: 'ro' })),
    ...['state', 'space'].map((name): Mount => ({ source: join(root, name), path: `/${name}`, mode: 'rw', maximumBytes: 67108864 })),
    { source: join(shared.root, 'endpoint/service.sock'), path: '/services/provider.sock', mode: 'ro' }
  ] }, caller.token, context); assert.ok(started.ok, JSON.stringify(started));
  return { root, process: started.value, token: caller.token, rows: () => readFile(join(root, 'observed.jsonl'), 'utf8'), async close() {
    const stopped = await started.value.stop('test complete'); assert.ok(stopped.ok); await journal.value.close(); await rm(root, { recursive: true, force: true });
  } };
}
