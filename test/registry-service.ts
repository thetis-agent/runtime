/** Exercise registry startup and cache delivery in its actual sandbox; ADR 0007, ADR 0017. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
import { git } from '@/lib/registry/git.ts';
import { packageEntry, packageMounts } from '@/test/package-mounts.ts';

export async function registryService() {
  const root = await mkdtemp('/tmp/registry-service-'); const time = new ManualClock(); const schemas = new Schemas(); await schemas.load();
  for (const name of ['cache', 'endpoint', 'source']) await mkdir(join(root, name));
  assert.ok((await git(join(root, 'registry'), ['init', '--bare'])).ok);
  await writeFile(join(root, 'source/package.json'), JSON.stringify({ name: 'sample', version: '1.0.0', requires: {}, provides: {}, settings: {}, envelope: { requires: [], provides: [], spawn: { scope: 'deployment', network: 'none' } } }));
  await writeFile(join(root, 'source/index.ts'), 'export const stages = {};');
  const journal = await Journal.open(join(root, 'rows.jsonl'), () => time.now()); assert.ok(journal.ok);
  const identity = new Identity({ people: [], authorities: {}, bindings: [] }, () => time.now());
  const issued = identity.issue({ id: 'registry', person: '', scope: 'deployment', target: 'registry', generation: 1, services: [] }); assert.ok(issued.ok);
  const operations = new Map<Method, Operation>([
    ['health.probe', () => Promise.resolve({ ok: true, value: { ready: true } })],
    ['profile.get', () => Promise.resolve({ ok: true, value: { cache: '/cache', registry: '/registry', sources: ['/sources/sample'] } })]
  ]);
  const context: Context = { target: 'registry', identity, schemas, clock: time, journal: journal.value, runner: new SandboxRunner('/cgroup'), operations: { methods: operations, notes: ['run.stop', 'env.updated'], note: () => Promise.resolve({ ok: true, value: undefined }) } };
  const repository = new URL('..', import.meta.url).pathname.replace(/\/$/u, '');
  const started = await Process.start({ name: 'fixture', version: '1.0.0', entry: packageEntry(repository, 'registries', 'service.ts'), args: [], cwd: '/cache', mounts: [
    ...packageMounts(repository, ['registries']),
    ...['cache', 'endpoint', 'registry'].map((name): Mount => ({ source: join(root, name), path: `/${name}`, mode: 'rw', maximumBytes: 67108864 })),
    { source: join(root, 'source'), path: '/sources/sample', mode: 'ro' }
  ] }, issued.value, context); assert.ok(started.ok, JSON.stringify(started));
  return { process: started.value, root, schemas, async close() {
    const stopped = await started.value.stop('test complete'); assert.ok(stopped.ok); await journal.value.close(); await rm(root, { recursive: true, force: true });
  } };
}
