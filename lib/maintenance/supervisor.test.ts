/** Exercise a supervised kernel's control socket, its kernel-resolved maintenance authority and its bounded generation store paths; GN-007, ADR 0048, implementation note 0050. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { Generations } from '@/kernel/generations/index.ts';
import { Journal } from '@/kernel/log/index.ts';
import { Schemas, isObject } from '@/lib/schema/index.ts';
import { snapshot } from '@/lib/snapshots/index.ts';
import { connect, socketFrames, send } from '@/lib/ndjson/socket.ts';
import { delegated } from '@/lib/sandbox-runner/cgroup.ts';

import { authority } from '@/test/trusted-fixture.ts';
import type { Target } from '@/lib/deployment/types.ts';
import { kernelRevision, readKernelPins } from './pins.ts';
import { parse, roots, supervise, supervisorLimits } from './supervisor.ts';

const repository = new URL('../..', import.meta.url).pathname.replace(/\/$/u, '');
const authorityPins = ['kernel', 'lib', 'contracts', ...['ajv', 'semver', 'ws', 'yaml', 'fast-uri', 'fast-deep-equal', 'json-schema-traverse', 'require-from-string'].map(name => `node_modules/${name}`)];
const held = { machine: Generations, journal: Journal };

async function published(destination: string): Promise<string> {
  const pins: Record<string, string> = {};
  for (const name of authorityPins) {
    const target = join(destination, name); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const hash = await snapshot(join(repository, name), target); assert.ok(hash.ok, JSON.stringify(hash));
    pins[name] = hash.value;
  }
  await writeFile(join(destination, 'kernel-pins.json'), JSON.stringify({ entry: 'kernel/maintenance-main.ts', pins }));
  return destination;
}

async function seed(state: string): Promise<string> {
  const source = join(repository, 'test/fixtures'); const hash = await snapshot(source); assert.ok(hash.ok);
  const targetState = join(state, 't'); await mkdir(targetState, { recursive: true, mode: 0o700 });
  await mkdir(join(state, 'k'), { recursive: true, mode: 0o700 });
  const target: Target = { id: 'authority', owner: '', scope: 'deployment', state: targetState, profile: {}, entries: [], services: [], revision: {
    plan: { name: 'fixture', version: '1.0.0', entry: join(source, 'evidence-process.ts'), args: [], cwd: '/state' },
    pins: { fixture: { source, hash: hash.value, mount: source } }, mounts: ['lib', 'contracts', 'node_modules'].map(name => ({ source: join(repository, name), path: join(repository, name), mode: 'ro' as const })),
    stateMount: '/state', endpointMount: '/endpoint', socketName: 'service.sock', quotaBytes: 67108864, formats: [], migrations: [], migrate: 'stop' } };
  const path = join(state, 'seed.json');
  await writeFile(path, JSON.stringify({ version: 1, root: join(state, 'k'), cgroup: '/cgroup', targets: [target],
    identity: { people: [{ id: 'admin', role: 'admin', projects: [], observeOthers: true }], bindings: [{ kind: 'password', id: 'external-admin', person: 'admin' }], authorities: { password: 'authority' } } }));
  return path;
}

async function control(path: string, command: Record<string, unknown>): Promise<Record<string, unknown>> {
  const socket = await connect(path); assert.ok(socket.ok, JSON.stringify(socket));
  try {
    assert.ok((await send(socket.value, command)).ok);
    const frame = await socketFrames(socket.value).next();
    assert.ok(!frame.done && frame.value.ok && isObject(frame.value.value)); return frame.value.value;
  } finally { socket.value.destroy(); }
}

/** A failed assertion must not leave the supervisor serving, or the test file never finishes. */
async function halt(path: string): Promise<void> {
  const socket = await connect(path); if (!socket.ok) return;
  try { await send(socket.value, { id: 'halt', method: 'stop' }); await socketFrames(socket.value).next(); }
  catch { /* the supervisor has already stopped */ }
  finally { socket.value.destroy(); }
}

async function ready(path: string, running: Promise<unknown>): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const socket = await connect(path);
    if (socket.ok) { socket.value.destroy(); return; }
    const stopped: unknown = await Promise.race([running, new Promise(resolve => setTimeout(resolve, 100))]);
    if (stopped !== undefined) assert.fail(`The supervisor stopped before it was ready: ${JSON.stringify(stopped)}`);
  }
  assert.fail('The supervisor control socket never accepted a connection.');
}

async function admin(state: string, stores: string): Promise<string> {
  assert.ok((await readdir(stores)).length > 0, 'The supervised kernel published no generation store.');
  const endpoint = join(state, 'live', 'targets', createHash('sha256').update('authority').digest('base64url'), 'runs/public/current.sock');
  assert.ok(Buffer.byteLength(endpoint) <= 107, `${endpoint} exceeds the Linux socket path limit at ${String(Buffer.byteLength(endpoint))} bytes.`);
  const asserted = await authority(endpoint, 'identity.assert', { kind: 'password', id: 'external-admin', evidence: {} });
  assert.equal(asserted['ok'], true, JSON.stringify(asserted)); assert.ok(isObject(asserted['value']));
  const token = asserted['value']['sessionToken']; assert.equal(typeof token, 'string');
  return typeof token === 'string' ? token : '';
}

await test('a supervised state root is refused before it can push a target endpoint past the socket path limit', () => {
  const args = { seed: '/x/seed.json', release: '/x', delegated: false };
  const short = roots({ ...args, state: '/var/lib/z' }, '/var/lib/z/k'); assert.ok(short.ok, JSON.stringify(short));
  assert.equal(short.value.stores, '/var/lib/z/g'); assert.equal(short.value.control, '/var/lib/z/supervisor.sock');
  const long = roots({ ...args, state: `/var/lib/${'z'.repeat(supervisorLimits.stateRootBytes)}` }, '/x/k');
  assert.equal(long.ok, false); assert.equal(long.error.code, 'invalid-args');
  const derived = roots(args, '/var/lib/z/k'); assert.ok(derived.ok); assert.equal(derived.value.state, '/var/lib/z');
});

await test('the supervisor accepts one configuration path with named flags and refuses anything else', () => {
  const parsed = parse(['/etc/zero/seed.json', '--release', '/opt/zero/current', '--state', '/var/lib/z', '--credential', '/c/master', '--delegate']);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.deepEqual(parsed.value, { seed: '/etc/zero/seed.json', release: '/opt/zero/current', state: '/var/lib/z', credential: '/c/master', delegated: true });
  assert.equal(parse([]).ok, false); assert.equal(parse(['a', 'b']).ok, false); assert.equal(parse(['a', '--unknown', 'b']).ok, false); assert.equal(parse(['a', '--release']).ok, false);
  const bare = parse(['/etc/zero/seed.json']); assert.ok(bare.ok); assert.equal(bare.value.release, repository); assert.equal(bare.value.delegated, false);
});

await test('a delegated cgroup root is a fresh run scope, or the service root the supervisor was told to expect', () => {
  assert.equal(delegated('/sys/fs/cgroup/user.slice/run-a1.scope'), true);
  assert.equal(delegated('/sys/fs/cgroup/system.slice/zero.service'), false);
  assert.equal(delegated('/sys/fs/cgroup/system.slice/zero.service', '/sys/fs/cgroup/system.slice/zero.service'), true);
  assert.equal(delegated('/sys/fs/cgroup/user.slice/run-a1.scope', '/sys/fs/cgroup/user.slice/run-a1.scope'), true);
  assert.equal(delegated('/sys/fs/cgroup/system.slice/zero.service', '/sys/fs/cgroup/system.slice/other.service'), false);
  assert.equal(delegated('/sys/fs/cgroup/system.slice/zero.slice', '/sys/fs/cgroup/system.slice/zero.slice'), false);
});

await test('GN-002 a supervised revision uses the hashes its release published and refuses a tree that differs', async () => {
  const root = await mkdtemp('/assembly/p'); const schemas = new Schemas(); await schemas.load();
  const configuration = { version: 1 as const, root: '/unused', cgroup: '/cgroup', targets: [], identity: { people: [], bindings: [], authorities: {} } };
  try {
    const release = await published(join(root, 'release'));
    const manifest = await readKernelPins(release, schemas); assert.ok(manifest.ok, JSON.stringify(manifest));
    assert.equal(manifest.value.entry, 'kernel/maintenance-main.ts'); assert.equal(Object.keys(manifest.value.pins).length, authorityPins.length);
    const revision = await kernelRevision(release, configuration, schemas); assert.ok(revision.ok, JSON.stringify(revision));
    assert.equal(revision.value.pins['kernel']?.source, join(release, 'kernel'));
    await writeFile(join(release, 'kernel-pins.json'), JSON.stringify({ entry: 'kernel/maintenance-main.ts', pins: { ...manifest.value.pins, kernel: `sha256:${'0'.repeat(64)}` } }));
    const refused = await kernelRevision(release, configuration, schemas);
    assert.equal(refused.ok, false); assert.equal(refused.error.code, 'hash-mismatch');
    await writeFile(join(release, 'kernel-pins.json'), JSON.stringify({ entry: '../escape.ts', pins: manifest.value.pins }));
    assert.equal((await readKernelPins(release, schemas)).ok, false);
    await rm(join(release, 'kernel-pins.json'));
    assert.equal((await kernelRevision(release, configuration, schemas)).ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('GN-007 the supervisor answers status, refuses maintenance without an administrator session the kernel resolved, and updates then undoes through the transaction', async () => {
  const state = await mkdtemp('/tmp/s'); const releases = await mkdtemp('/assembly/r');
  const path = await seed(state); const places = roots({ seed: path, release: releases, state, delegated: false }, join(state, 'k'));
  assert.ok(places.ok, JSON.stringify(places));
  const first = await published(join(releases, 'a')); const second = await published(join(releases, 'b'));
  let running = supervise([path, '--state', state, '--release', first], held);
  try {
    await ready(places.value.control, running);
    const initial = await control(places.value.control, { id: '1', method: 'status' });
    assert.equal(initial['ok'], true, JSON.stringify(initial)); assert.ok(isObject(initial['value'])); assert.ok(isObject(initial['value']['view']));
    assert.equal(initial['value']['view']['state'], 'LIVE'); assert.equal(initial['value']['release'], first); assert.equal(initial['value']['previous'], null);
    assert.ok(isObject(initial['value']['view']['current'])); assert.equal(initial['value']['view']['current']['n'], 1);
    await writeFile(join(state, 'live/retained-marker'), 'before-update');
    const anonymous = await control(places.value.control, { id: '2', method: 'update', release: second, baseline: 1 });
    assert.equal(anonymous['ok'], false); assert.ok(isObject(anonymous['error'])); assert.equal(anonymous['error']['code'], 'invalid-args');
    const forged = await control(places.value.control, { id: '3', method: 'update', release: second, baseline: 1, session: 'forged' });
    assert.equal(forged['ok'], false, JSON.stringify(forged));
    const second_ = await supervise([path, '--state', state, '--release', first], held);
    assert.equal(second_.ok, false); assert.equal(second_.error.code, 'conflict');
    const updated = await control(places.value.control, { id: '4', method: 'update', release: second, baseline: 1, session: await admin(state, places.value.stores) });
    assert.equal(updated['ok'], true, JSON.stringify(updated));
    const promoted = await control(places.value.control, { id: '5', method: 'status' });
    assert.ok(isObject(promoted['value']) && isObject(promoted['value']['view']) && isObject(promoted['value']['view']['current']));
    assert.equal(promoted['value']['view']['state'], 'LIVE'); assert.equal(promoted['value']['view']['current']['n'], 2); assert.equal(promoted['value']['release'], second);
    assert.equal(await readFile(join(state, 'live/retained-marker'), 'utf8'), 'before-update');
    await writeFile(join(state, 'live/retained-marker'), 'after-update');
    const undone = await control(places.value.control, { id: '6', method: 'undo', baseline: 2, session: await admin(state, places.value.stores) });
    assert.equal(undone['ok'], true, JSON.stringify(undone));
    const restored = await control(places.value.control, { id: '7', method: 'status' });
    assert.ok(isObject(restored['value']) && isObject(restored['value']['view']) && isObject(restored['value']['view']['current']));
    assert.equal(restored['value']['view']['current']['n'], 3); assert.equal(restored['value']['release'], first);
    assert.equal(await readFile(join(state, 'live/retained-marker'), 'utf8'), 'before-update', 'Undo must restore the previous stopped store.');
    await writeFile(join(state, 'live/retained-marker'), 'after-undo');
    const rows = await readFile(join(places.value.supervisor, 'observed.jsonl'), 'utf8');
    assert.equal(rows.split('\n').filter(row => row.includes('"target":"kernel"') && row.includes('"to":"LIVE"')).length, 2);
    assert.equal((await control(places.value.control, { id: '8', method: 'stop' }))['ok'], true);
    const closed = await running; assert.ok(closed.ok, JSON.stringify(closed));
    running = supervise([path, '--state', state, '--release', first], held);
    await ready(places.value.control, running);
    const rebooted = await control(places.value.control, { id: '9', method: 'status' });
    assert.ok(isObject(rebooted['value']) && isObject(rebooted['value']['view']) && isObject(rebooted['value']['view']['current']));
    assert.equal(rebooted['value']['view']['current']['n'], 4);
    assert.equal(rebooted['value']['release'], first); assert.equal(rebooted['value']['previous'], second);
    assert.equal(await readFile(join(state, 'live/retained-marker'), 'utf8'), 'after-undo', 'A restart discarded the serving store.');
    assert.ok(await admin(state, places.value.stores));
    const pruned = await control(places.value.control, { id: '10', method: 'prune' }); assert.equal(pruned['ok'], true, JSON.stringify(pruned));
    assert.equal((await readdir(places.value.stores)).length, 2, 'Only live and previous stores should remain.');
  } finally {
    await halt(places.value.control); await Promise.race([running, new Promise(resolve => setTimeout(resolve, 30000))]);
    await rm(state, { recursive: true, force: true }); await rm(releases, { recursive: true, force: true });
  }
});
