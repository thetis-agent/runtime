/** Keep task cost ceilings on ordinary authenticated runs and durable reservations; PR-010, EV-006. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { MockProvider } from '@/packages/provider-mock/index.ts';
import { providerFixture, collect, request, stream } from '@/test/provider-fixture.ts';
import { BudgetCheckpoint } from './checkpoint.ts';
import { Budgets } from './index.ts';
import { Schemas } from '@/lib/schema/index.ts';
import { reserve } from './reservation.ts';

await test('PR-010 a trusted run ceiling refuses vendor access and cannot be enlarged by request options', async () => {
  const f = providerFixture();
  const token = f.identity.issue({ id: 'limited', person: 'person', scope: 'person', target: 'limited', generation: 1, services: ['instance'], cost: 0.001 }); assert.ok(token.ok);
  const result = await collect(f.provider.run(stream(request('system', { options: { cost: 100 } })), token.value, new AbortController().signal));
  assert.ok(result.some(event => event.type === 'error' && event.code === 'budget'));
  assert.equal(f.provider.capturedPrefixes.length, 0); assert.equal(f.reports.length, 0);
});

await test('PR-010 a live run cannot renew its lifetime ceiling after person-window expiry or restart', async () => {
  const root = await mkdtemp('/tmp/run-lifetime-'); const path = join(root, 'budget.json'); const schemas = new Schemas(); let now = 0;
  const rule = { name: 'daily', cost: 100, requests: 100, windowMs: 1000 };
  const caller = { person: 'alice', scope: 'person' as const, cost: 1, expires: 10000 };
  try {
    const opened = await BudgetCheckpoint.open(path, schemas); assert.ok(opened.ok);
    const budgets = new Budgets(rule, () => now, 4096, opened.value);
    const first = reserve(budgets, caller, 'same-token', 1, 'deployment'); assert.ok(first.ok); first.value(1);
    assert.ok((await budgets.checkpoint()).ok); now = 1000;
    assert.ok(!reserve(budgets, caller, 'same-token', 0.01, 'deployment').ok);
    const reopened = await BudgetCheckpoint.open(path, schemas); assert.ok(reopened.ok);
    assert.ok(!reserve(new Budgets(rule, () => now, 4096, reopened.value), caller, 'same-token', 0.01, 'deployment').ok);
    assert.ok(!(await readFile(path, 'utf8')).includes('same-token'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('PR-010 expired run entries are reclaimed only after pending reservations settle', () => {
  let now = 0; const budgets = new Budgets({ name: 'daily', cost: 100, requests: 1, windowMs: 1000 }, () => now, 1);
  const caller = { person: 'alice', scope: 'person' as const, cost: 1, expires: 2000 };
  const first = reserve(budgets, caller, 'first', 0.1, 'person'); assert.ok(first.ok);
  now = 1000;
  const next = reserve(budgets, caller, 'first', 0.2, 'person'); assert.ok(next.ok);
  now = 2000;
  assert.ok(!reserve(budgets, caller, 'first', 0, 'person').ok);
  const other = { ...caller, expires: 3000 };
  assert.ok(!reserve(budgets, other, 'second', 0.1, 'person').ok);
  first.value(0.1); next.value(0.2);
  assert.ok(reserve(budgets, other, 'second', 0.1, 'person').ok);
});

await test('PR-010 run accounting refuses missing, changed or invalid trusted retirement dates', () => {
  const budgets = new Budgets({ name: 'daily', cost: 1, requests: 100, windowMs: 1000 }, () => 0, 1);
  const caller = { person: 'alice', scope: 'person' as const, cost: 1 };
  assert.ok(!reserve(budgets, caller, 'token', 0.1, 'person').ok);
  for (const expires of [0, -1, Infinity, NaN]) assert.ok(!reserve(budgets, { ...caller, expires }, 'token', 0.1, 'person').ok);
  const first = reserve(budgets, { ...caller, expires: 2000 }, 'token', 0.1, 'person'); assert.ok(first.ok); first.value(0.1);
  assert.ok(!reserve(budgets, { ...caller, expires: 3000 }, 'token', 0.1, 'person').ok);
  assert.ok(reserve(budgets, { ...caller, expires: 2000 }, 'token', 0.1, 'person').ok);
});

await test('PR-010 legacy synthetic run records retain their spent ceiling after migration and expiry of the old window', async () => {
  const root = await mkdtemp('/tmp/run-migration-'); const path = join(root, 'budget.json'); const schemas = new Schemas(); let now = 1000;
  const rule = { name: 'daily', cost: 100, requests: 100, windowMs: 1000 };
  const caller = { person: 'alice', scope: 'person' as const, cost: 1, expires: 2000 };
  try {
    const digest = createHash('sha256').update('legacy-token').digest('hex');
    await writeFile(path, JSON.stringify({ version: 1, windows: [{ person: `\0run:${digest}`, at: 0, spent: 0.75, reserved: 0.25, requests: 1 }] }));
    const opened = await BudgetCheckpoint.open(path, schemas); assert.ok(opened.ok);
    const budgets = new Budgets(rule, () => now, 1, opened.value);
    assert.ok(!reserve(budgets, caller, 'legacy-token', 0.01, 'person').ok);
    assert.ok((await budgets.checkpoint()).ok);
    const reopened = await BudgetCheckpoint.open(path, schemas); assert.ok(reopened.ok);
    assert.equal(reopened.value.initial.runs[0]?.spent, '1'); assert.equal(reopened.value.initial.runs[0].expires, 2000);
    now = 2000;
    assert.ok(reserve(new Budgets(rule, () => now, 1, reopened.value), { ...caller, expires: 3000 }, 'new-token', 1, 'person').ok);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('PR-010 settled per-run spend survives provider restart without persisting its credential', async () => {
  const root = await mkdtemp('/tmp/run-cost-'); const schemas = new Schemas(); await schemas.load(); const f = providerFixture();
  const token = f.identity.issue({ id: 'bounded', person: 'person', scope: 'person', target: 'bounded', generation: 1, services: ['instance'], cost: 0.015 }); assert.ok(token.ok);
  const path = join(root, 'budget.json'); const rule = { name: 'cost', cost: 10, requests: 100, windowMs: 86400000 };
  try {
    const initial = await BudgetCheckpoint.open(path, schemas); assert.ok(initial.ok);
    const first = new MockProvider([[{ type: 'usage', counters: { cost: 0.01 } }]], f.authority, new Budgets(rule, () => 0, 4096, initial.value));
    assert.ok((await collect(first.run(stream(request()), token.value, new AbortController().signal))).some(event => event.type === 'stop'));
    const stored = await readFile(path, 'utf8'); assert.equal(stored.includes(token.value), false);
    const resumed = await BudgetCheckpoint.open(path, schemas); assert.ok(resumed.ok);
    const second = new MockProvider([], f.authority, new Budgets(rule, () => 0, 4096, resumed.value));
    const refused = await collect(second.run(stream(request()), token.value, new AbortController().signal));
    assert.ok(refused.some(event => event.type === 'error' && event.code === 'budget')); assert.equal(second.capturedPrefixes.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
