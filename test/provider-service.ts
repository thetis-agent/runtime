/** Assemble real identity, accounting and bubblewrap around a registered service; PR-010–013. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Identity } from '../kernel/identity/index.ts';
import { Journal } from '../kernel/log/index.ts';
import { Usage } from '../kernel/boundary/usage.ts';
import { Process } from '../kernel/boundary/process.ts';
import type { Context } from '../kernel/boundary/process.ts';
import type { Operation } from '../kernel/socket/index.ts';
import type { Method } from '../contracts/kernel-socket/types.ts';
import { Schemas, isObject } from '../lib/schema/index.ts';
import { ManualClock } from '../lib/events/index.ts';
import { SandboxRunner } from '../lib/sandbox-runner/index.ts';
import type { Mount } from '../lib/sandbox-runner/index.ts';
import { ProviderClient } from '../lib/provider/client.ts';

function accounting(usage: Usage): Operation {
  return (run, params) => {
    const { runToken, callId, counters } = params;
    assert.ok(typeof runToken === 'string' && typeof callId === 'string' && isObject(counters));
    const cost = counters['cost']; assert.ok(typeof cost === 'number');
    const values: Record<string, number> = {};
    for (const [name, value] of Object.entries(counters)) { assert.ok(typeof value === 'number'); values[name] = value; }
    return usage.report(run, { runToken, callId, counters: { ...values, cost } });
  };
}

export async function serviceFixture(cost = 0.011) {
  const root = await mkdtemp('/tmp/provider-service-'); const time = new ManualClock(); const schemas = new Schemas(); await schemas.load();
  await mkdir(join(root, 'state')); await mkdir(join(root, 'endpoint'));
  const journal = await Journal.open(join(root, 'rows.jsonl'), () => time.now()); assert.ok(journal.ok);
  const identity = new Identity({ people: ['alice', 'bob'].map(id => ({ id, role: 'user', projects: [], observeOthers: false })), authorities: {}, bindings: [] }, () => time.now());
  const issued = identity.issue({ id: 'shared', person: 'alice', scope: 'deployment', target: 'shared', generation: 1, services: [] }); assert.ok(issued.ok);
  const usage = new Usage(identity, journal.value, () => time.now());
  const operations = new Map<Method, Operation>([
    ['health.probe', () => Promise.resolve({ ok: true, value: { ready: true } })],
    ['profile.get', () => Promise.resolve({ ok: true, value: { rule: { name: 'shared-cost', cost, requests: 100, windowMs: 86400000 }, settings: {} } })],
    ['token.whois', (_run, params) => { assert.ok(typeof params['runToken'] === 'string'); return Promise.resolve(identity.whois(issued.value, params['runToken'])); }],
    ['usage.report', accounting(usage)]
  ]);
  const context: Context = { target: 'shared', identity, schemas, clock: time, journal: journal.value, runner: new SandboxRunner('/cgroup'), operations: { methods: operations, notes: ['run.stop', 'env.updated'], note: () => Promise.resolve({ ok: true, value: undefined }) } };
  const repository = new URL('..', import.meta.url).pathname.replace(/\/$/u, '');
  const started = await Process.start({ name: 'fixture', version: '1.0.0', entry: `${repository}/packages/provider-mock/service.ts`, args: [], cwd: '/state', mounts: [
    ...['lib', 'contracts', 'node_modules', 'packages/provider-mock'].map((name): Mount => ({ source: `${repository}/${name}`, path: `${repository}/${name}`, mode: 'ro' })),
    ...['state', 'endpoint'].map((name): Mount => ({ source: join(root, name), path: `/${name}`, mode: 'rw', maximumBytes: 67108864 }))
  ] }, issued.value, context); assert.ok(started.ok, JSON.stringify(started));
  return { process: started.value, root, identity, client(person: string) {
    const token = identity.issue({ id: person, person, scope: 'person', target: person, generation: 1, services: ['shared'] }); assert.ok(token.ok);
    return { token: token.value, provider: new ProviderClient(join(root, 'endpoint/service.sock'), schemas, token.value) };
  }, rows: () => readFile(join(root, 'rows.jsonl'), 'utf8'), async close() {
    const stopped = await started.value.stop('test complete'); assert.ok(stopped.ok); await journal.value.close(); await rm(root, { recursive: true, force: true });
  } };
}
