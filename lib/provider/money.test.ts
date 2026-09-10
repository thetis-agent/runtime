/** Exercise decimal ceiling boundaries and the full finite numeric range; implementation note 0044, PR-010. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balance, decimal, money } from './money.ts';
import { Budgets } from './index.ts';

await test('PR-010 money preserves decimal sums, exponent notation and every supported magnitude', () => {
  assert.equal(money(0.1) + money(0.2), money(0.3));
  assert.equal(decimal(money(1e-7)), '0.0000001');
  for (const value of [0, 0.01, 0.1, 0.2, 0.3, 1e-7, 1e21, Number.MIN_VALUE, Number.MAX_VALUE]) {
    const encoded = decimal(money(value));
    assert.equal(balance(encoded), money(value)); assert.equal(Number(encoded), value);
  }
  for (const invalid of [-1, Infinity, -Infinity, NaN]) assert.throws(() => money(invalid));
});

await test('PR-010 exact decimal ceilings allow 0.1 plus 0.2 and refuse any further positive spend', () => {
  const budgets = new Budgets({ name: 'decimal', cost: 0.3, requests: 10, windowMs: 1000 }, () => 0);
  const first = budgets.reserve('alice', 0.1); assert.ok(first.ok);
  const second = budgets.reserve('alice', 0.2); assert.ok(second.ok);
  assert.ok(!budgets.reserve('alice', Number.MIN_VALUE).ok);
  second.value(0.2); first.value(0.1);
  assert.ok(!budgets.reserve('alice', Number.MIN_VALUE).ok);
});
