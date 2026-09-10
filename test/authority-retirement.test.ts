/** Close real empty authority descriptors without consuming permanent target slots; KS-008, ADR 0046. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Runtime } from '../kernel/boundary/runtime.ts';
import { Identity } from '../kernel/identity/index.ts';
import { Journal } from '../kernel/log/index.ts';
import { Schemas } from '../lib/schema/index.ts';
import { ManualClock } from '../lib/events/index.ts';
import { SandboxRunner } from '../lib/sandbox-runner/index.ts';
import { processGeneration, person } from './process-generation.ts';
import type { Setup } from '../lib/package-loader/types.ts';

await test('KS-008 repeatedly closing real empty authority sockets returns identity capacity', async () => {
  const root = await mkdtemp('/tmp/authority-'); const clock = new ManualClock();
  const schemas = new Schemas(); await schemas.load();
  const journal = await Journal.open(join(root, 'observed.jsonl'), () => clock.now()); assert.ok(journal.ok);
  const identity = new Identity({ people: [], bindings: [], authorities: {}, tokens: 2 }, () => clock.now());
  const runtime = new Runtime({ root, clock, schemas, identity, journal: journal.value, runner: new SandboxRunner('/cgroup') });
  try {
    for (let n = 0; n < 8; n++) {
      const authority = await runtime.emptyAuthority(); assert.ok(authority.ok, JSON.stringify(authority));
      assert.ok(identity.authenticate(authority.value.token).ok);
      assert.ok((await authority.value.close()).ok);
      assert.equal(identity.authenticate(authority.value.token).ok, false);
    }
  } finally { assert.ok((await runtime.close()).ok); await journal.value.close(); await rm(root, { recursive: true, force: true }); }
});

await test('KS-008 stopped and failed real transient executions release their identity slots', async () => {
  const f = await processGeneration(); const root = await mkdtemp('/tmp/tr-');
  const identity = new Identity({ people: [person], bindings: [], authorities: {}, tokens: 2 }, () => f.clock.now());
  const runtime = new Runtime({ ...f.context, root, identity });
  const pin = f.old.pins['entry']; assert.ok(pin);
  const plan = { ...f.old.plan, args: ['healthy', '/endpoint/service.sock', 'shared'], mounts: [...f.old.mounts,
    { source: pin.source, path: pin.mount, mode: 'ro' as const }, { source: join(f.root, 'state'), path: '/state', mode: 'rw' as const, maximumBytes: 67108864 }] };
  const setup: Setup = { entries: [], profile: {}, provided: {}, spaces: [], excluded: [], runtime: {
    root: '/state', providerSocket: '/none', person: person.id, model: 'scripted', provider: 'none', token: 'inherited', space: '/work', system: [], roots: [], mode: { readOnly: false, deny: [] }
  } };
  try {
    for (let n = 0; n < 4; n++) {
      const refused = await runtime.transient(person.id, [], { ...plan, entry: '/revision/missing.ts' }, setup, { cost: 1 }); assert.ok(!refused.ok);
      const started = await runtime.transient(person.id, [], plan, setup, { cost: 1 }); assert.ok(started.ok, JSON.stringify(started));
      assert.ok((await started.value.process.probe()).ok);
      assert.ok((await started.value.process.stop('execution complete')).ok);
    }
  } finally { assert.ok((await runtime.close()).ok); await rm(root, { recursive: true, force: true }); await f.close(); }
});
