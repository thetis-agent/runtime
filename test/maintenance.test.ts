/** Exercise real copied kernel code and retain a connected old client on incompatible negotiation; GN-007. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Maintenance } from '@/lib/maintenance/index.ts';
import { exportDeployment } from '@/lib/deployment/store-export.ts';
import { snapshot } from '@/lib/snapshots/index.ts';
import { Schemas } from '@/lib/schema/index.ts';
import { ManualClock } from '@/lib/events/index.ts';
import { Journal } from '@/kernel/log/index.ts';
import { Identity } from '@/kernel/identity/index.ts';
import { maintenance as authorize } from '@/kernel/generations/maintenance.ts';
import { Generations } from '@/kernel/generations/index.ts';
import { connect } from '@/lib/ndjson/socket.ts';
import { Peer } from '@/lib/socket/index.ts';
import type { Revision } from '@/lib/maintenance/index.ts';
const repository = new URL('..', import.meta.url).pathname;
async function revision(): Promise<Revision> {
  const pins: Record<string, { source: string; hash: string }> = {};
  for (const name of ['kernel', 'lib', 'contracts', ...['ajv', 'semver', 'ws', 'yaml', 'fast-uri', 'fast-deep-equal', 'json-schema-traverse', 'require-from-string'].map(name => `node_modules/${name}`)]) {
    const source = join(repository, name); const hash = await snapshot(source); assert.ok(hash.ok, JSON.stringify(hash)); pins[name] = { source, hash: hash.value };
  }
  return { pins, entry: 'kernel/maintenance-main.ts', configuration: { version: 1, root: '/unused', cgroup: '/cgroup', targets: [], identity: { people: [{ id: 'admin', role: 'admin', projects: [], observeOthers: true }], bindings: [], authorities: {} } } };
}
await test('GN-007 incompatible actual kernel handshake preserves the old connected client before SWITCHING; compatible code promotes', async () => {
  const root = await mkdtemp('/tmp/km-'); const schemas = new Schemas(); await schemas.load(); const clock = new ManualClock();
  const opened = await Journal.open(join(root, 'observed.jsonl'), () => clock.now()); assert.ok(opened.ok);
  const state = join(root, 'initial'); await mkdir(state); const current = await revision();
  const started = await Maintenance.start({ root: join(root, 'host'), schemas, clock, administrator: 'admin', currentMajor: '1', capture: exportDeployment, machine: initial => new Generations('kernel', initial, opened.value, () => clock.now()) }, current, state);
  assert.ok(started.ok, JSON.stringify(started)); const maintenance = started.value;
  const identity = new Identity({ people: current.configuration.identity.people, bindings: [{ kind: 'password', id: 'admin', person: 'admin' }], authorities: { password: 'login' } }, () => clock.now());
  const session = identity.session('login', 'password', 'admin'); assert.ok(session.ok); const upgrade = authorize(identity, maintenance);
  assert.equal((await upgrade('forged', current, 1)).ok, false);
  const socket = await connect(maintenance.endpoint); assert.ok(socket.ok);
  const client = new Peer(socket.value, schemas, clock, ['health.probe'], { handlers: new Map(), note: () => Promise.resolve({ ok: true, value: undefined }) });
  try {
    assert.ok((await client.connect()).ok); assert.ok((await client.call('health.probe', {})).ok);
    const changed = join(root, 'incompatible'); const source = current.pins['kernel']; assert.ok(source);
    assert.ok((await snapshot(source.source, changed)).ok);
    const entry = join(changed, 'maintenance-main.ts'); await writeFile(entry, (await readFile(entry, 'utf8')).replace("host(start, ['1'])", "host(start, ['2'])"));
    const hash = await snapshot(changed); assert.ok(hash.ok);
    const refused = await upgrade(session.value.sessionToken, { ...current, pins: { ...current.pins, kernel: { source: changed, hash: hash.value } } }, 1);
    assert.equal(refused.ok, false, JSON.stringify(refused)); assert.equal(maintenance.machine.view.state, 'LIVE'); assert.equal(maintenance.machine.view.current.n, 1);
    assert.ok((await client.call('health.probe', {})).ok);
    assert.doesNotMatch(await readFile(join(root, 'observed.jsonl'), 'utf8'), /"to":"SWITCHING"/u);
    const promoted = await upgrade(session.value.sessionToken, current, 1); assert.ok(promoted.ok, JSON.stringify(promoted));
    assert.equal(maintenance.machine.view.state, 'LIVE'); assert.equal(maintenance.machine.view.current.n, 2);
  } finally { client.close(); assert.ok((await maintenance.close()).ok); await opened.value.close(); await rm(root, { recursive: true, force: true }); }
});
