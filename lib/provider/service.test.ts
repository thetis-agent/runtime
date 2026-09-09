/** Exercise the shipped entry in its actual sandbox with kernel accounting; PR-001, PR-010–012. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceFixture } from '../../test/provider-service.ts';
import { collect, stream, request } from '../../test/provider-fixture.ts';
import { isObject } from '../schema/index.ts';

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
    assert.equal(await readFile(join(f.root, 'state/budget.json'), 'utf8'), '{"version":1,"windows":[]}');
  } finally { await f.close(); }
});
