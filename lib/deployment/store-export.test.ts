/** Prove that maintenance copies durable state without carrying live endpoints or old host paths; GN-007. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportDeployment } from './store-export.ts';
import { runtimeFixture, people } from '../../test/runtime-fixture.ts';
import { Runtime } from '../../kernel/boundary/runtime.ts';
import { Journal } from '../../kernel/log/index.ts';
import { Identity } from '../../kernel/identity/index.ts';
import { SandboxRunner } from '../sandbox-runner/index.ts';

await test('GN-007 exported stopped store replays verified pins after host-root relocation', async () => {
  const f = await runtimeFixture(); const destination = await mkdtemp('/tmp/ke-');
  const root = join(destination, 's');
  try {
    assert.ok((await f.runtime.close()).ok);
    const copied = await exportDeployment(f.root, root); assert.ok(copied.ok, JSON.stringify(copied));
    const journal = await Journal.open(join(root, 'observed.jsonl'), () => f.clock.now()); assert.ok(journal.ok);
    const identity = new Identity({ people, bindings: [], authorities: {} }, () => f.clock.now());
    const runtime = new Runtime({ root: join(root, 'targets'), recoveryJournal: join(root, 'observed.jsonl'), identity, schemas: f.schemas, clock: f.clock, journal: journal.value, runner: new SandboxRunner('/cgroup') });
    try {
      const started = await runtime.start(f.shared); assert.ok(started.ok, JSON.stringify(started));
      const person = people[0]; assert.ok(person);
      const status = runtime.status({ ...person, role: 'admin' }, f.shared.id); assert.ok(status.ok); assert.equal(status.value['generation'], 2);
      const current = runtime.current(f.shared.id); assert.ok(current.ok);
      assert.ok(Object.values(current.value.revision.pins).every(pin => pin.source.startsWith(`${root}/`)));
    } finally { assert.ok((await runtime.close()).ok); await journal.value.close(); }
  } finally { await f.close(); await rm(destination, { recursive: true, force: true }); }
});

await test('Stopped store export refuses non-endpoint symlinks and nested destinations', async () => {
  const root = await mkdtemp('/tmp/export-refusal-'); const output = `${root}-copy`;
  try {
    await writeFile(join(root, 'value'), 'state'); await symlink(join(root, 'value'), join(root, 'link'));
    const refused = await exportDeployment(root, output); assert.ok(!refused.ok); assert.equal(refused.error.code, 'outside-roots');
    assert.equal((await exportDeployment(root, join(root, 'nested'))).ok, false);
  } finally { await rm(root, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }); }
});
