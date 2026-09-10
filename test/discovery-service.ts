/** Probe real exported registrations in a sandbox that can write only disposable state; TE-021, ADR 0027. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Identity } from '@/kernel/identity/index.ts';
import { Journal } from '@/kernel/log/index.ts';
import { Process } from '@/kernel/boundary/process.ts';
import type { Context } from '@/kernel/boundary/process.ts';
import type { Operation } from '@/kernel/socket/index.ts';
import type { Method } from '@/contracts/kernel-socket/types.ts';
import { Schemas } from '@/lib/schema/index.ts';
import { ManualClock } from '@/lib/events/index.ts';
import { SandboxRunner } from '@/lib/sandbox-runner/index.ts';
import type { Mount } from '@/lib/sandbox-runner/index.ts';
import { discover } from '@/lib/package-loader/index.ts';
import { packagesRoot } from '@/lib/profile/packages-root.ts';
import { packageEntry, packageMounts } from '@/test/package-mounts.ts';

export async function discoveryService(all = false) {
  const root = await mkdtemp('/tmp/discovery-service-'); const time = new ManualClock(); const schemas = new Schemas(); await schemas.load();
  await mkdir(join(root, 'state')); await mkdir(join(root, 'endpoint'));
  const repository = new URL('..', import.meta.url).pathname.replace(/\/$/u, '');
  const entries = await discover(packagesRoot(repository), '/state/packages', {}, schemas); assert.ok(entries.ok);
  const selected = entries.value.filter(entry => all || entry.manifest.name === 'provider-mock');
  const journal = await Journal.open(join(root, 'rows.jsonl'), () => time.now()); assert.ok(journal.ok);
  const identity = new Identity({ people: [], authorities: {}, bindings: [] }, () => time.now());
  const issued = identity.issue({ id: 'discovery', person: '', scope: 'deployment', target: 'discovery', generation: 1, services: [] }); assert.ok(issued.ok);
  const operations = new Map<Method, Operation>([
    ['health.probe', () => Promise.resolve({ ok: true, value: { ready: true } })],
    ['profile.get', () => Promise.resolve({ ok: true, value: { roots: [repository], state: '/state', setup: { entries: selected, profile: {}, provided: {}, spaces: [], excluded: [] } } })]
  ]);
  const context: Context = { target: 'discovery', identity, schemas, clock: time, journal: journal.value, runner: new SandboxRunner('/cgroup'), operations: { methods: operations, notes: ['run.stop', 'env.updated'], note: () => Promise.resolve({ ok: true, value: undefined }) } };
  const started = await Process.start({ name: 'fixture', version: '1.0.0', entry: packageEntry(repository, 'core', 'discovery-service.ts'), args: [], cwd: '/state', mounts: [
    ...packageMounts(repository, ['core', ...selected.map(entry => entry.manifest.name)]),
    ...['state', 'endpoint'].map((name): Mount => ({ source: join(root, name), path: `/${name}`, mode: 'rw', maximumBytes: 67108864 }))
  ] }, issued.value, context); assert.ok(started.ok, JSON.stringify(started));
  return { process: started.value, root, schemas, sources: selected.map(entry => `${entry.manifest.name}@${entry.manifest.version}`), async close() {
    const stopped = await started.value.stop('test complete'); assert.ok(stopped.ok); await journal.value.close(); await rm(root, { recursive: true, force: true });
  } };
}
