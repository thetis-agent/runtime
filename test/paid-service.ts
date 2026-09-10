/** Start registered paid tools with real secret delivery, identity, isolation, and accounting; TS-008. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Runtime } from '@/kernel/boundary/runtime.ts';
import { Secrets } from '@/kernel/secrets/index.ts';
import { Identity } from '@/kernel/identity/index.ts';
import { Journal } from '@/kernel/log/index.ts';
import { Schemas } from '@/lib/schema/index.ts';
import { ManualClock } from '@/lib/events/index.ts';
import { SandboxRunner } from '@/lib/sandbox-runner/index.ts';
import { ToolClient } from '@/lib/service/tool-client.ts';
import { discover } from '@/lib/package-loader/index.ts';
import { packagesRoot } from '@/lib/profile/packages-root.ts';
import { revision } from '@/test/runtime-fixture.ts';
import { administrator } from '@/test/default-act.ts';
import type { Spawn } from '@/lib/package-loader/types.ts';

export async function paidService(name: string, spawn: Spawn, secret: { name: string; value: string }, cost: number) {
  const root = await mkdtemp('/tmp/pt-'); const state = join(root, 'initial'); await mkdir(state);
  const schemas = new Schemas(); await schemas.load(); const time = new ManualClock(); const epoch = Date.now();
  const journal = await Journal.open(join(root, 'observed.jsonl'), () => time.now()); assert.ok(journal.ok);
  const identity = new Identity({ people: ['alice', 'bob'].map(id => ({ id, role: 'user', projects: [], observeOthers: false })), bindings: [], authorities: {} }, () => epoch + time.now());
  const master = randomBytes(32); const secrets = await Secrets.open(join(root, 'sealed'), master); master.fill(0); assert.ok(secrets.ok);
  assert.ok((await secrets.value.set(administrator, 'kernel', { scope: 'deployment', name: secret.name, value: secret.value })).ok);
  const runtime = new Runtime({ root: join(root, 'targets'), schemas, clock: time, journal: journal.value, identity, runner: new SandboxRunner('/cgroup'), secrets: secrets.value });
  const entries = await discover(packagesRoot(), '/state/packages', {}, schemas); assert.ok(entries.ok);
  const entry = entries.value.find(entry => entry.manifest.name === name); assert.ok(entry);
  const plan = await revision(name, 'service.ts');
  const started = await runtime.start({ id: 'tools', owner: '', scope: 'deployment', environment: false, state, revision: plan, services: [], entries: [entry],
    profile: { provided: Object.fromEntries(Object.keys(entry.manifest.requires).map(name => [name, { version: name === 'contract/turn-events' ? '1.1.0' : '1.0.0' }])),
      rule: { name: 'paid-test', cost, requests: 20, windowMs: 86400000 }, settings: {} },
    registration: { package: name, id: spawn.id, declared: spawn } });
  if (!started.ok) { await runtime.close(); await journal.value.close(); await rm(root, { recursive: true, force: true }); assert.fail(JSON.stringify(started)); }
  const endpoint = runtime.endpoint('tools'); assert.ok(endpoint.ok); const clients: ToolClient[] = [];
  return { root, runtime, identity, schemas, entry, endpoint: endpoint.value, client(person: string, granted = true) {
    const issued = identity.issue({ id: `${person}-${String(granted)}`, person, scope: 'person', target: person, generation: 1, services: granted ? ['tools'] : [] }); assert.ok(issued.ok);
    const client = new ToolClient(issued.value, schemas); clients.push(client);
    return { token: issued.value, client };
  }, rows: () => readFile(join(root, 'observed.jsonl'), 'utf8'), async close() {
    for (const client of clients) client.close(); const stopped = await runtime.close(); await journal.value.close(); await rm(root, { recursive: true, force: true }); assert.ok(stopped.ok);
  } };
}
