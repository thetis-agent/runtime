/** Retain unfinished reservations across a real persisted restart; PR-010, ADR 0020. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BudgetCheckpoint } from './checkpoint.ts';
import { Budgets } from './index.ts';
import { Schemas } from '../schema/index.ts';
import { providerFixture, collect, stream, request } from '../../test/provider-fixture.ts';
import { MockProvider } from '../../packages/provider-mock/index.ts';

const rule = { name: 'daily', cost: 1, requests: 100, windowMs: 1000 };

await test('PR-010 restart keeps unfinished reservations charged and never restores their transient credentials', async () => {
  const root = await mkdtemp('/tmp/budget-checkpoint-'); const path = join(root, 'budget.json'); const schemas = new Schemas();
  try {
    const first = await BudgetCheckpoint.open(path, schemas); assert.ok(first.ok);
    const live = new Budgets(rule, () => 0, 4096, first.value);
    assert.ok(live.reserve('alice', 0.75).ok); assert.ok((await live.checkpoint()).ok);
    const restored = await BudgetCheckpoint.open(path, schemas); assert.ok(restored.ok);
    const after = new Budgets(rule, () => 0, 4096, restored.value); assert.ok(!after.reserve('alice', 0.3).ok);
    const remainder = after.reserve('alice', 0.25); assert.ok(remainder.ok); remainder.value(0.1); assert.ok((await after.checkpoint()).ok);
    assert.ok(!(await readFile(path, 'utf8')).includes('token'));
    const reopened = await BudgetCheckpoint.open(path, schemas); assert.ok(reopened.ok);
    assert.ok(!new Budgets(rule, () => 0, 4096, reopened.value).reserve('alice', 0.2).ok);
    assert.ok(new Budgets(rule, () => 1000, 4096, reopened.value).reserve('alice', 1).ok);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('PR-010 the real mock persists its reservation before yielding a vendor event and retains it after disconnect', async () => {
  const root = await mkdtemp('/tmp/budget-admission-'); const path = join(root, 'budget.json'); const schemas = new Schemas();
  try {
    const state = await BudgetCheckpoint.open(path, schemas); assert.ok(state.ok);
    const f = providerFixture(); const provider = new MockProvider([], f.authority, new Budgets({ ...rule, cost: 0.01 }, () => 0, 4096, state.value));
    for await (const event of provider.run(stream(request()), f.token, new AbortController().signal)) {
      assert.equal(event.type, 'start');
      const persisted = await BudgetCheckpoint.open(path, schemas); assert.ok(persisted.ok);
      assert.equal(persisted.value.initial[0]?.reserved, 0.01); break;
    }
    const after = await BudgetCheckpoint.open(path, schemas); assert.ok(after.ok);
    assert.equal(after.value.initial[0]?.spent, 0.01); assert.equal(after.value.initial[0].reserved, 0);
    assert.ok(!new Budgets({ ...rule, cost: 0.01 }, () => 0, 4096, after.value).reserve('person', 0.001).ok);
    assert.ok(!(await readFile(path, 'utf8')).includes(f.token));
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('PR-010 malformed state and failed reservation writes cannot reach a vendor', async () => {
  const root = await mkdtemp('/tmp/budget-refusal-'); const path = join(root, 'budget.json'); const schemas = new Schemas();
  try {
    await writeFile(path, '{"version":1,"windows":[{"person":"alice","at":0,"spent":-1,"reserved":0,"requests":0}]}');
    assert.ok(!(await BudgetCheckpoint.open(path, schemas)).ok); await rm(path);
    const state = await BudgetCheckpoint.open(path, schemas); assert.ok(state.ok);
    const f = providerFixture(); const provider = new MockProvider([], f.authority, new Budgets(rule, () => 0, 4096, state.value));
    await rm(root, { recursive: true, force: true });
    const rows = await collect(provider.run(stream(request()), f.token, new AbortController().signal));
    assert.equal(rows.at(-1)?.type, 'error'); assert.equal(provider.vendorCalls, 0);
    const refused = await collect(provider.run(stream(request()), f.token, new AbortController().signal));
    assert.equal(refused.at(-1)?.type, 'error'); assert.equal(provider.vendorCalls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
