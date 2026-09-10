/** Exercise kernel-owned operation policy through real sandbox credentials and dispatch; KS-011, KS-020, KS-022. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Runtime } from '@/kernel/boundary/runtime.ts';
import type { RuntimeContext, Target } from '@/kernel/boundary/runtime.ts';
import { Identity } from '@/kernel/identity/index.ts';
import { Journal } from '@/kernel/log/index.ts';
import { ManualClock } from '@/lib/events/index.ts';
import { SandboxRunner } from '@/lib/sandbox-runner/index.ts';
import { Schemas, failure, isObject } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import { Pins } from '@/lib/pins/index.ts';
import { snapshot } from '@/lib/snapshots/index.ts';
import { connect, send, socketFrames } from '@/lib/ndjson/socket.ts';
import type { Method, Note } from '@/contracts/kernel-socket/types.ts';
import type { Operation } from '@/kernel/socket/index.ts';
import { revision, person } from '@/test/process-generation.ts';

const repository = new URL('../..', import.meta.url).pathname.replace(/\/$/u, '');
const relay = `/** Relay test requests over the actual inherited authority; KS-001, KS-022. */
import { createServer } from 'node:net';
import { authority } from '${repository}/lib/sandbox-runner/authority.ts';
import { Peer } from '${repository}/lib/socket/index.ts';
import type { Handler } from '${repository}/lib/socket/index.ts';
import { Schemas } from '${repository}/lib/schema/index.ts';
import type { Result } from '${repository}/lib/schema/index.ts';
import { socketFrames } from '${repository}/lib/ndjson/socket.ts';
import { clock } from '${repository}/lib/events/index.ts';
import type { Method, Note, Request } from '${repository}/contracts/kernel-socket/types.ts';
const received = await authority();
if (!received.ok) throw new Error(received.error.message);
const inherited = received.value;
const schemas = new Schemas(); await schemas.load();
const note = schemas.validator<Note>('kernel-socket', 'note');
const request = schemas.validator<Request>('kernel-socket', 'request');
const handlers = new Map<Method, Handler>([
  ['health.probe', () => Promise.resolve({ ok: true, value: { ready: true } })]
]);
const peer = new Peer(inherited.socket, schemas, clock,
  ['health.probe', 'profile.get', 'token.whois', 'identity.assert', 'prune', 'run.stop', 'env.updated', 'notice', 'turn.report'],
  { handlers, note: () => Promise.resolve({ ok: true, value: undefined }) });
const server = createServer(socket => {
  void (async () => {
    const incoming = await socketFrames(socket).next();
    if (incoming.done || !incoming.value.ok) throw new Error('The relay request is absent.');
    const frame = incoming.value.value;
    let result: Result<unknown>;
    if (note(frame)) {
      const sent = await peer.notify(frame);
      result = sent.ok ? await peer.call('health.probe', {}) : sent;
    } else if (request(frame)) {
      if (frame['self'] === true) frame.params['runToken'] = inherited.token;
      result = await peer.call(frame.method, frame.params);
    } else throw new Error('The relay request violates its schema.');
    socket.end(JSON.stringify(result) + '\\n');
  })().catch(() => { socket.destroy(); });
});
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen('/endpoint/private.sock', resolve); });
const connected = await peer.connect();
if (!connected.ok) throw new Error(connected.error.message);
await peer.finished();
server.close();
`;

async function fixture(extension: NonNullable<RuntimeContext['extension']> = () => ({ methods: new Map(), capabilities: [] })) {
  const root = await mkdtemp('/tmp/runtime-ops-');
  await mkdir(join(root, 'state')); await mkdir(join(root, 'work'));
  await writeFile(join(root, 'state/value.json'), JSON.stringify({ version: 1 }));
  const clock = new ManualClock(); const schemas = new Schemas(); await schemas.load();
  const opened = await Journal.open(join(root, 'observed.jsonl'), () => clock.now()); assert.ok(opened.ok);
  const journal = opened.value;
  const identity = new Identity({ people: [person], bindings: [{ kind: 'password', id: 'external-alice', person: person.id }], authorities: { password: 'authority' } }, () => clock.now());
  const runtime = new Runtime({ root: join(root, 'targets'), identity, schemas, clock, journal, runner: new SandboxRunner('/cgroup'), extension });
  const prepared = await revision(root, 'relay', 'healthy', 1, false);
  const pin = prepared.pins['entry']; assert.ok(pin);
  await writeFile(join(pin.source, 'index.ts'), relay);
  const hash = await snapshot(pin.source); assert.ok(hash.ok);
  const target: Target = {
    id: person.id, owner: person.id, scope: 'person', state: join(root, 'state'), services: [], entries: [],
    revision: { ...prepared, pins: { entry: { ...pin, hash: hash.value } } },
    profile: { label: 'initial', runtime: { generation: -1 } }
  };
  return { root, runtime, target, identity, schemas, async close() {
    const stopped = await runtime.close(); await journal.close(); await rm(root, { recursive: true, force: true });
    assert.ok(stopped.ok, JSON.stringify(stopped));
  } };
}

async function exchange(runtime: Runtime, target: string, frame: Record<string, unknown>): Promise<Result<unknown>> {
  const endpoint = runtime.endpoint(target); assert.ok(endpoint.ok);
  const socket = await connect(endpoint.value); assert.ok(socket.ok);
  try {
    assert.ok((await send(socket.value, { id: 'relay', ...frame })).ok);
    const incoming = await socketFrames(socket.value).next(); assert.ok(!incoming.done && incoming.value.ok);
    const result = incoming.value.value; assert.ok(isObject(result));
    if (result['ok'] === true) return { ok: true, value: result['value'] };
    assert.equal(result['ok'], false);
    const error = result['error']; assert.ok(isObject(error) && typeof error['code'] === 'string' && typeof error['message'] === 'string');
    return failure(error['code'], error['message']);
  } finally { socket.value.destroy(); }
}

function call(runtime: Runtime, target: string, method: Method, params: Record<string, unknown>, self = false): Promise<Result<unknown>> {
  return exchange(runtime, target, { method, params, self });
}

await test('KS-022 an extension cannot replace a kernel identity operation', async () => {
  let invoked = false;
  const methods = new Map<Method, Operation>([['token.whois', () => { invoked = true; return Promise.resolve({ ok: true, value: {} }); }]]);
  const f = await fixture(() => ({ methods, capabilities: [] }));
  try {
    await assert.rejects(f.runtime.start(f.target), { message: 'An extension cannot replace kernel authority.' });
    assert.equal(invoked, false);
    assert.equal((await readFile(join(f.root, 'observed.jsonl'), 'utf8')).includes('process.start'), false);
  } finally { await f.close(); }
});

await test('KS-011 dispatched prune refuses live conversation pins before invoking the extension', async () => {
  const released: unknown[] = [];
  const methods = new Map<Method, Operation>([['prune', (_run, params) => { released.push(params['id']); return Promise.resolve({ ok: true, value: 'released' }); }]]);
  const f = await fixture(() => ({ methods, capabilities: [] }));
  try {
    const held = `sha256:${'a'.repeat(64)}`; const free = `sha256:${'b'.repeat(64)}`;
    const pins = new Pins(join(f.root, 'targets/conversation-pins.json'), f.schemas);
    assert.ok((await pins.pin({ target: person.id, conversation: 'live', hashes: [held] })).ok);
    assert.ok((await f.runtime.start(f.target)).ok);
    assert.deepEqual(await call(f.runtime, person.id, 'prune', { id: held }), failure('conflict', 'The release is pinned by live conversation live.'));
    const invalid = await call(f.runtime, person.id, 'prune', {}); assert.ok(!invalid.ok); assert.equal(invalid.error.code, 'invalid-args');
    assert.deepEqual(released, []);
    assert.deepEqual(await call(f.runtime, person.id, 'prune', { id: free }), { ok: true, value: 'released' });
    assert.deepEqual(released, [free]);
  } finally { await f.close(); }
});

await test('KS-022 dispatched identity operations retain run equality and designated deployment authority', async () => {
  const f = await fixture();
  try {
    assert.ok((await f.runtime.start(f.target)).ok);
    const own = await call(f.runtime, person.id, 'token.whois', {}, true); assert.ok(own.ok && isObject(own.value));
    assert.equal(own.value['person'], person.id); assert.equal(own.value['target'], person.id); assert.equal(own.value['generation'], 1);
    const other = f.identity.issue({ id: 'other-run', person: person.id, scope: 'person', target: person.id, generation: 1, services: [] }); assert.ok(other.ok);
    assert.deepEqual(await call(f.runtime, person.id, 'token.whois', { runToken: other.value }), failure('forbidden', 'Only deployment scope can resolve another run.'));
    const unknown = await call(f.runtime, person.id, 'token.whois', { runToken: 'never-issued' }); assert.ok(!unknown.ok); assert.equal(unknown.error.code, 'auth');
    const evidence = { kind: 'password', id: 'external-alice', evidence: {} };
    assert.deepEqual(await call(f.runtime, person.id, 'identity.assert', evidence), failure('forbidden', 'The identity assertion requires a designated deployment authority.'));
    for (const target of ['authority', 'other-authority']) {
      assert.ok((await f.runtime.start({ ...f.target, id: target, owner: '', scope: 'deployment' })).ok);
      const resolved = await call(f.runtime, target, 'token.whois', { runToken: other.value }); assert.ok(resolved.ok && isObject(resolved.value));
      assert.equal(resolved.value['id'], 'other-run');
      const asserted = await call(f.runtime, target, 'identity.assert', evidence);
      if (target === 'authority') {
        assert.ok(asserted.ok && isObject(asserted.value)); assert.equal(asserted.value['person'], person.id);
        const token = asserted.value['sessionToken']; assert.ok(typeof token === 'string'); assert.ok(f.identity.resolveSession(token).ok);
        assert.equal((await readFile(join(f.root, 'observed.jsonl'), 'utf8')).includes(token), false);
      } else assert.deepEqual(asserted, failure('forbidden', 'This authority cannot assert password.'));
    }
    assert.equal((await readFile(join(f.root, 'observed.jsonl'), 'utf8')).includes(other.value), false);
  } finally { await f.close(); }
});

await test('GN-004 profile dispatch reads the new generation without mutating the recorded profile', async () => {
  const f = await fixture();
  try {
    assert.ok((await f.runtime.start(f.target)).ok);
    assert.deepEqual(await call(f.runtime, person.id, 'profile.get', {}), { ok: true, value: { label: 'initial', runtime: { generation: 1 } } });
    assert.deepEqual(f.target.profile, { label: 'initial', runtime: { generation: -1 } });
    const changed = { ...f.target, profile: { label: 'changed', runtime: 'preserved' } };
    const switched = await f.runtime.switch(person, changed, 1); assert.ok(switched.ok, JSON.stringify(switched));
    assert.deepEqual(await call(f.runtime, person.id, 'profile.get', {}), { ok: true, value: changed.profile });
  } finally { await f.close(); }
});

for (const rejected of ['run.stop', 'env.updated'] satisfies Note['note'][]) await test(`KS-020 reported notes cannot claim kernel ${rejected} control`, async () => {
  const f = await fixture();
  try {
    assert.ok((await f.runtime.start(f.target)).ok);
    for (const note of ['notice', 'turn.report']) assert.ok((await exchange(f.runtime, person.id, { note, params: { marker: note } })).ok);
    const refused = await exchange(f.runtime, person.id, { note: rejected, params: { marker: 'forged-control' } }); assert.ok(!refused.ok);
    const rows = (await readFile(join(f.root, 'observed.jsonl'), 'utf8')).trim().split('\n').map((row): unknown => JSON.parse(row)).filter(isObject);
    assert.deepEqual(rows.filter(row => row['provenance'] === 'candidate-reported').map(row => [row['target'], row['kind']]), [[person.id, 'notice'], [person.id, 'turn.report']]);
    assert.equal(JSON.stringify(rows).includes('forged-control'), false);
  } finally { await f.close(); }
});
