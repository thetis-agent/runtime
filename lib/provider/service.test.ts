/** Exercise the shipped entry in its actual sandbox with kernel accounting; PR-001, PR-010–012. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceFixture } from '@/test/provider-service.ts';
import { collect, stream, request } from '@/test/provider-fixture.ts';
import { isObject } from '@/lib/schema/index.ts';

await test('PR-011 a real sandboxed shared service attributes both callers and durably enforces their individual budgets', async () => {
  const f = await serviceFixture();
  try {
    assert.ok((await f.process.probe()).ok);
    const alice = f.client('alice'); const bob = f.client('bob');
    assert.ok((await alice.provider.describe()).ok);
    const turn = (caller: typeof alice) => collect(caller.provider.run(stream(request('stored head '.repeat(4096))), caller.token, new AbortController().signal));
    const first = await turn(alice); const second = await turn(alice); const other = await turn(bob); const refused = await turn(alice);
    for (const rows of [first, second, other]) assert.equal(rows.at(-1)?.type, 'stop');
    assert.ok(refused.some(row => row.type === 'error' && row.code === 'budget' && row.message.includes('shared-cost')));
    const cached = second.find(row => row.type === 'usage'); assert.ok(cached); assert.ok((cached.counters['cached'] ?? 0) / (cached.counters['in'] ?? 1) >= 0.99);
    const rows = await f.rows(); assert.equal(rows.split('\n').filter(row => row.includes('usage.report')).length, 3);
    assert.ok(rows.includes('reviewed-reported')); assert.ok(rows.includes('"person":"alice"')); assert.ok(rows.includes('"person":"bob"'));
    const state = await readFile(join(f.root, 'state/budget.json'), 'utf8');
    for (const token of [alice.token, bob.token]) { assert.ok(!rows.includes(token)); assert.ok(!state.includes(token)); }
    assert.ok(state.includes('alice')); assert.ok(state.includes('bob'));
  } finally { await f.close(); }
});

await test('GN-004 a shared service quiesces and resumes after an announced rollback without restarting', async () => {
  const f = await serviceFixture();
  try {
    assert.ok((await f.process.probe()).ok); const alice = f.client('alice'); const pid = f.process.running.process.pid;
    const drained = await f.process.drain(30000); assert.ok(drained.ok); assert.equal(drained.value.killed, false);
    assert.ok(!(await alice.provider.describe()).ok);
    assert.ok((await f.process.probe()).ok);
    assert.ok((await f.process.control.notify({ note: 'env.updated', params: { resume: true } })).ok);
    const status = await f.process.control.call('health.probe', {}); assert.ok(status.ok && isObject(status.value)); assert.equal(status.value['draining'], false);
    assert.ok((await alice.provider.describe()).ok); assert.equal(f.process.running.process.pid, pid);
  } finally { await f.close(); }
});

await test('PR-012 a real shared service refuses unknown credentials without reserving or reporting a call', async () => {
  const f = await serviceFixture();
  try {
    assert.ok((await f.process.probe()).ok); const alice = f.client('alice');
    const response = await collect(alice.provider.run(stream(request()), 'unknown', new AbortController().signal));
    assert.ok(response.some(row => row.type === 'error' && row.code === 'auth'));
    assert.ok(!(await f.rows()).includes('usage.report'));
    assert.equal(await readFile(join(f.root, 'state/budget.json'), 'utf8'), '{"version":2,"people":[],"runs":[]}');
  } finally { await f.close(); }
});

await test('PR-010 a cost-bound run crosses the real service boundary and retains its exact lifetime ceiling', async () => {
  const f = await serviceFixture(1, { scripts: [[{ type: 'usage', counters: { cost: 0.01 } }]] });
  try {
    assert.ok((await f.process.probe()).ok); const caller = f.client('alice');
    const bounded = f.identity.issue({ id: 'bounded', person: 'alice', scope: 'person', target: 'bounded', generation: 1, services: ['shared'], cost: 0.01 });
    assert.ok(bounded.ok);
    const first = await collect(caller.provider.run(stream(request()), bounded.value, new AbortController().signal));
    assert.equal(first.at(-1)?.type, 'stop', JSON.stringify(first));
    const second = await collect(caller.provider.run(stream(request()), bounded.value, new AbortController().signal));
    assert.ok(second.some(row => row.type === 'error' && row.code === 'budget' && row.message.includes('would be exceeded')));
    assert.equal((await f.rows()).split('\n').filter(row => row.includes('usage.report')).length, 1);
  } finally { await f.close(); }
});

await test('PR-014 the registered sandboxed mock serves configured scripts and reports early vendor errors', async () => {
  const f = await serviceFixture(1, { scripts: [[{ type: 'delta.text', text: 'Configured response.' }], [{ type: 'error', code: 'rate-limit', message: 'Scripted refusal.' }]] });
  try {
    assert.ok((await f.process.probe()).ok); const caller = f.client('alice');
    const first = await collect(caller.provider.run(stream(request()), caller.token, new AbortController().signal));
    assert.ok(first.some(row => row.type === 'delta.text' && row.text === 'Configured response.'));
    const second = await collect(caller.provider.run(stream(request()), caller.token, new AbortController().signal));
    assert.ok(second.some(row => row.type === 'error' && row.code === 'rate-limit'));
    assert.equal((await f.rows()).split('\n').filter(row => row.includes('usage.report')).length, 2);
  } finally { await f.close(); }
});

await test('KS-022 a sandboxed personal service authenticates only its same run and reports candidate usage without deployment charging', async () => {
  const f = await serviceFixture(0, {}, 'person');
  try {
    assert.ok((await f.process.probe()).ok); const caller = f.client('alice'); const other = f.client('bob');
    const rows = await collect(caller.provider.run(stream(request()), caller.token, new AbortController().signal));
    assert.equal(rows.at(-1)?.type, 'stop');
    const rejected = await collect(other.provider.run(stream(request()), other.token, new AbortController().signal));
    assert.ok(rejected.some(row => row.type === 'error' && row.code === 'auth'));
    const log = await f.rows(); assert.ok(log.includes('candidate-reported')); assert.ok(!log.includes('reviewed-reported'));
    assert.equal(log.split('\n').filter(row => row.includes('usage.report')).length, 1);
    assert.equal(await readFile(join(f.root, 'state/budget.json'), 'utf8'), '{"version":2,"people":[],"runs":[]}');
  } finally { await f.close(); }
});
