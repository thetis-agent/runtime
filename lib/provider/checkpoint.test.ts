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
      assert.equal(persisted.value.initial.people[0]?.reserved, '0.01'); break;
    }
    const after = await BudgetCheckpoint.open(path, schemas); assert.ok(after.ok);
    assert.equal(after.value.initial.people[0]?.spent, '0.01'); assert.equal(after.value.initial.people[0].reserved, '0');
    assert.ok(!new Budgets({ ...rule, cost: 0.01 }, () => 0, 4096, after.value).reserve('person', 0.001).ok);
    assert.ok(!(await readFile(path, 'utf8')).includes(f.token));
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('PR-010 concurrent decimal settlements reopen exactly and reclaim their expired pool entry', async () => {
  const root = await mkdtemp('/tmp/budget-decimal-'); const path = join(root, 'budget.json'); const schemas = new Schemas(); let now = 0;
  try {
    const opened = await BudgetCheckpoint.open(path, schemas); assert.ok(opened.ok);
    const budgets = new Budgets(rule, () => now, 1, opened.value);
    const reservations = Array.from({ length: 3 }, () => budgets.reserve('alice', 0.01));
    for (const reservation of reservations) { assert.ok(reservation.ok); reservation.value(0.01); }
    assert.ok((await budgets.checkpoint()).ok);
    const reopened = await BudgetCheckpoint.open(path, schemas); assert.ok(reopened.ok);
    assert.equal(reopened.value.initial.people[0]?.reserved, '0');
    assert.equal(reopened.value.initial.people[0].spent, '0.03');
    const restored = new Budgets(rule, () => now, 1, reopened.value);
    assert.ok(restored.reserve('alice', 0.97).ok);
    assert.ok(!restored.reserve('alice', Number.MIN_VALUE).ok);
    now = rule.windowMs;
    assert.ok(budgets.reserve('bob', 1).ok);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('PR-010 restart retains unsettled person reservations across a rate-window rollover', async () => {
  const root = await mkdtemp('/tmp/budget-rollover-'); const path = join(root, 'budget.json'); const schemas = new Schemas(); let now = 0;
  try {
    const opened = await BudgetCheckpoint.open(path, schemas); assert.ok(opened.ok);
    const budgets = new Budgets(rule, () => now, 1, opened.value);
    const pending = budgets.reserve('alice', 0.75); assert.ok(pending.ok);
    now = rule.windowMs;
    assert.ok(!budgets.reserve('alice', 0.3).ok);
    assert.ok((await budgets.checkpoint()).ok);
    const reopened = await BudgetCheckpoint.open(path, schemas); assert.ok(reopened.ok);
    assert.ok(!new Budgets(rule, () => now, 1, reopened.value).reserve('alice', 0.3).ok);
    pending.value(0.75);
    assert.ok(budgets.reserve('alice', 0.25).ok);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('PR-010 malformed new snapshots are refused before replacing the last durable ledger', async () => {
  const root = await mkdtemp('/tmp/budget-snapshot-'); const path = join(root, 'budget.json'); const schemas = new Schemas();
  try {
    const opened = await BudgetCheckpoint.open(path, schemas); assert.ok(opened.ok);
    const before = await readFile(path, 'utf8');
    const person = { person: 'alice', at: 0, requests: 0, spent: '-0.01', reserved: '0' };
    assert.ok(!(await opened.value.save({ version: 2, people: [person], runs: [] })).ok);
    person.spent = '0';
    assert.ok(!(await opened.value.save({ version: 2, people: [person, person], runs: [] })).ok);
    const people = Array.from({ length: 4096 }, (_, index) => ({ ...person, person: String(index) }));
    const run = { digest: 'a'.repeat(64), at: 0, requests: 0, spent: '0', reserved: '0' };
    assert.ok(!(await opened.value.save({ version: 2, people, runs: [run] })).ok);
    assert.equal(await readFile(path, 'utf8'), before);
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
