/** Run the real loop and imported tools inside the worker over real provider and control sockets; TE-001, ADR 0027. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Environment } from './environment.ts';
import { Schemas, isObject } from '../../lib/schema/index.ts';
import { ManualClock } from '../../lib/events/index.ts';
import { discover } from '../../lib/package-loader/index.ts';
import type { Note } from '../../contracts/kernel-socket/types.ts';
import type { Setup, WorkerMessage } from '../../lib/package-loader/types.ts';
import { listen } from '../../lib/provider/server.ts';
import { providerFixture } from '../../test/provider-fixture.ts';

await test('TE-001 the worker runs imported file tools and keeps provider events off its monitor messages', async () => {
  const root = await mkdtemp('/tmp/environment-'); const schemas = new Schemas(); await schemas.load(); const clock = new ManualClock();
  const provider = providerFixture([[{ type: 'delta.tool_call', callId: 'write', name: 'write_path', args: '{"path":"answer.txt","contents":"worker output"}' }], Array.from({ length: 1000 }, () => ({ type: 'delta.text', text: 'x' }))]);
  const service = await listen(join(root, 'provider.sock'), provider.provider, schemas, () => {}); assert.ok(service.ok);
  const reports: Note[] = [];
  const messages: WorkerMessage[] = []; const environment = new Environment(schemas, clock, message => { messages.push(message); }, note => { reports.push(note); return Promise.resolve({ ok: true, value: undefined }); });
  try {
    await mkdir(join(root, 'space'));
    const discovered = await discover(new URL('..', import.meta.url).pathname, join(root, 'packages'), {}, schemas); assert.ok(discovered.ok);
    const setup: Setup = { entries: discovered.value.filter(entry => entry.manifest.name === 'tools-files'), profile: {}, provided: {}, spaces: [], excluded: [], runtime: {
      root: join(root, 'conversations'), providerSocket: join(root, 'provider.sock'), person: 'person', model: 'scripted', provider: 'instance', token: provider.token,
      space: join(root, 'space'), system: [], roots: [{ path: join(root, 'space'), mode: 'rw', space: 'person' }], mode: { readOnly: false, deny: [] }
    } };
    assert.ok((await environment.start(setup)).ok);
    const created = await environment.call('session.create', { surface: 'faux' }); assert.ok(created.ok && isObject(created.value)); const id = created.value['id']; assert.ok(typeof id === 'string');
    const response = await environment.call('session.submit', { conversation: id, input: { text: 'Write the answer', attachments: [] } });
    assert.ok(response.ok && isObject(response.value), JSON.stringify(response)); assert.deepEqual(Object.keys(response.value).sort(), ['conversation', 'head']);
    assert.equal(await readFile(join(root, 'space/answer.txt'), 'utf8'), 'worker output');
    assert.equal(provider.provider.vendorCalls, 2); assert.equal(provider.reports.length, 2);
    assert.deepEqual(messages.map(message => message.type), ['initializing', 'ready']);
    assert.equal(reports.length, 1); const report = reports[0]; assert.ok(report);
    assert.equal(report.note, 'turn.report'); assert.equal(report.params['conversation'], id);
    assert.ok(Array.isArray(report.params['calls'])); const call: unknown = report.params['calls'][0];
    assert.ok(isObject(call)); assert.equal(call['id'], 'write'); assert.equal(call['name'], 'write_path'); assert.equal(call['outcome'], 'ok');
    assert.ok(!JSON.stringify(reports).includes('worker output')); assert.ok(!JSON.stringify(reports).includes(provider.token));
    assert.ok(!JSON.stringify(messages).includes(provider.token)); assert.ok(!JSON.stringify(response).includes('worker output'));
    const invalid = await environment.call('session.submit', { conversation: id, input: { text: 4 } }); assert.ok(!invalid.ok); assert.equal(invalid.error.code, 'invalid-args');
    const other = await environment.call('session.list', { person: 'someone-else' }); assert.ok(!other.ok); assert.equal(other.error.code, 'forbidden');
    assert.ok((await environment.notify({ note: 'run.stop', params: {} })).ok); assert.ok((await environment.call('health.probe', {})).ok);
    const paused = await environment.call('session.submit', { conversation: id, input: { text: 'paused', attachments: [] } }); assert.ok(!paused.ok); assert.equal(paused.error.code, 'switching');
    assert.ok((await environment.notify({ note: 'env.updated', params: { resume: true } })).ok); assert.ok((await environment.call('health.probe', {})).ok);
    assert.ok((await environment.call('session.create', { surface: 'faux' })).ok);
  } finally { assert.ok((await environment.close()).ok); assert.ok((await service.value.stop()).ok); await rm(root, { recursive: true, force: true }); }
});
