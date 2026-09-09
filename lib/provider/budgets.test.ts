/** Reserve across simultaneous calls and run credentials before spending; PR-010, ADR 0020. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Budgets } from './index.ts';

await test('Concurrent reservations share the person budget and settle once', () => {
  const budget = new Budgets({ name: 'daily', cost: 1, requests: 4, windowMs: 10 }, () => 0);
  const first = budget.reserve('person', 0.75); assert.ok(first.ok);
  assert.equal(budget.reserve('person', 0.5).ok, false);
  first.value(0.25);
  const second = budget.reserve('person', 0.75); assert.ok(second.ok);
  assert.throws(() => { first.value(0); });
  second.value(0.75);
  assert.equal(budget.reserve('person', 0.01).ok, false);
  assert.equal(budget.reserve('other', 1).ok, true);
});

await test('Budget request windows reset deterministically and invalid estimates refuse', () => {
  let now = 0;
  const budget = new Budgets({ name: 'daily', cost: 1, requests: 1, windowMs: 10 }, () => now, 1);
  for (const estimate of [-1, Infinity, NaN]) assert.equal(budget.reserve('person', estimate).ok, false);
  const first = budget.reserve('person', 0); assert.ok(first.ok); first.value(0);
  assert.equal(budget.reserve('person', 0).ok, false);
  assert.equal(budget.reserve('other', 0).ok, false);
  now = 10;
  assert.equal(budget.reserve('person', 0).ok, true);
});
