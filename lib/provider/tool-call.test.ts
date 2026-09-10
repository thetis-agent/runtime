/** Verify paid tool admission and durable settlement with real run identity; TS-005–007. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Schemas, failure } from '@/lib/schema/index.ts';
import { providerFixture } from '@/test/provider-fixture.ts';
import type { CallRequest, ToolDef } from '@/contracts/turn-events/types.ts';
import { PaidTools } from './tool-call.ts';
import { BudgetCheckpoint } from './checkpoint.ts';
import { Budgets } from './index.ts';
const request: CallRequest = { id: 'call', name: 'paid', args: {}, mode: { readOnly: false, deny: [] }, roots: [], deadlineMs: 100, budget: { resultBytes: 1000 } };
const definition: ToolDef = { name: 'paid', description: 'Paid operation', schema: { type: 'object' }, source: 'fixture@1.0.0', readOnly: false, endsTurn: false };
await test('TS-005 authentication, read-only policy, and trusted run ceilings precede vendor access', async () => {
  const f = providerFixture(); const schemas = new Schemas(); await schemas.load(); let calls = 0;
  const tools = new PaidTools({ definitions: [definition], estimate: () => 1, execute: call => { calls++; return Promise.resolve({ id: call.id, ok: true }); } }, f.authority, f.budgets, schemas);
  const limited = f.identity.issue({ id: 'limited', person: 'person', scope: 'person', target: 'limited', generation: 1, services: [], cost: 0.5 }); assert.ok(limited.ok);
  assert.equal((await tools.call(request, 'invalid', new AbortController().signal)).error?.code, 'tool');
  assert.equal((await tools.call({ ...request, mode: { readOnly: true, deny: [] } }, f.token, new AbortController().signal)).error?.code, 'read-only-mode');
  assert.equal((await tools.call(request, limited.value, new AbortController().signal)).error?.code, 'budget');
  assert.equal(calls, 0); assert.equal(f.reports.length, 0);
});
await test('TS-006 reservation survives restart and settlement precedes the returned answer', async () => {
  const root = await mkdtemp('/tmp/paid-tools-'); const path = join(root, 'budget.json');
  const schemas = new Schemas(); await schemas.load(); const f = providerFixture(); const rule = { name: 'paid', cost: 1, requests: 10, windowMs: 10000 };
  try {
    const state = await BudgetCheckpoint.open(path, schemas); assert.ok(state.ok);
    const tools = new PaidTools({ definitions: [definition], estimate: () => 1, execute: async call => {
      const saved = await BudgetCheckpoint.open(path, schemas); assert.ok(saved.ok);
      assert.equal(saved.value.initial.people[0]?.reserved, '1');
      assert.ok(!new Budgets(rule, () => 0, 4096, saved.value).reserve('person', 0.01).ok);
      return { id: call.id, ok: true };
    } }, f.authority, new Budgets(rule, () => 0, 4096, state.value), schemas);
    const result = await tools.call(request, f.token, new AbortController().signal); assert.ok(result.ok);
    assert.equal(result.data?.['reservedCost'], 1); assert.equal(f.reports.length, 1);
    const saved = await BudgetCheckpoint.open(path, schemas); assert.ok(saved.ok); assert.equal(saved.value.initial.people[0]?.spent, '1');
    assert.equal((await readFile(path, 'utf8')).includes(f.token), false);
    assert.equal((await tools.call(request, f.token, new AbortController().signal)).error?.code, 'budget');
  } finally { await rm(root, { recursive: true, force: true }); }
});
await test('TS-007 failed attribution freezes admission after one conservative charge', async () => {
  const f = providerFixture(); const schemas = new Schemas(); await schemas.load(); let calls = 0;
  const tools = new PaidTools({ definitions: [definition], estimate: () => 1, execute: () => { calls++; throw new Error('vendor failed'); } },
    { ...f.authority, report: () => Promise.resolve(failure('auth', 'failed')) }, f.budgets, schemas);
  assert.equal((await tools.call(request, f.token, new AbortController().signal)).error?.code, 'budget');
  assert.equal((await tools.call(request, f.token, new AbortController().signal)).error?.code, 'budget'); assert.equal(calls, 1);
});
