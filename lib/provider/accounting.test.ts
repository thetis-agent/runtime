/** Preserve final attribution even when a vendor or consumer ends early; PR-011, ADR 0020. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockProvider } from '@/packages/provider-mock/index.ts';
import { failure } from '@/lib/schema/index.ts';
import { providerFixture, collect, request, stream } from '@/test/provider-fixture.ts';

await test('PR-011 early vendor errors report the conservative reservation exactly once', async () => {
  const f = providerFixture([[{ type: 'error', code: 'auth', message: 'Rejected.' }]]);
  const rows = await collect(f.provider.run(stream(request()), f.token, new AbortController().signal));
  assert.equal(rows.at(-1)?.type, 'error'); assert.equal(f.reports.length, 1);
  assert.deepEqual(f.reports[0]?.counters, { cost: 0.01 });
  assert.equal(f.reports[0].callId, 'call'); assert.equal(f.reports[0].token, f.token);
});

await test('PR-011 disconnected consumers still settle and report without consuming the remaining stream', async () => {
  const f = providerFixture([[{ type: 'delta.text', text: 'first' }, { type: 'delta.text', text: 'unconsumed' }]]);
  for await (const event of f.provider.run(stream(request()), f.token, new AbortController().signal)) {
    if (event.type === 'delta.text') break;
  }
  assert.equal(f.reports.length, 1); assert.deepEqual(f.reports[0]?.counters, { cost: 0.01 });
});

await test('PR-011 an error after measured usage reports the last counters rather than the reservation', async () => {
  const f = providerFixture([[{ type: 'usage', counters: { cost: 0.004, custom: 7 } }, { type: 'error', code: 'provider', message: 'Interrupted.' }]]);
  const rows = await collect(f.provider.run(stream(request()), f.token, new AbortController().signal));
  assert.equal(rows.at(-1)?.type, 'error'); assert.equal(f.reports.length, 1);
  assert.deepEqual(f.reports[0]?.counters, { cost: 0.004, custom: 7 });
});

await test('PR-011 failed final attribution refuses later calls instead of continuing unreported spend', async () => {
  const f = providerFixture();
  const provider = new MockProvider([], { ...f.authority, report: () => Promise.resolve(failure('auth', 'The accounting edge refused.')) }, f.budgets);
  const rows = await collect(provider.run(stream(request()), f.token, new AbortController().signal));
  assert.ok(rows.some(row => row.type === 'error' && row.code === 'auth'));
  const later = await collect(provider.run(stream(request()), f.token, new AbortController().signal));
  assert.ok(later.some(row => row.type === 'error' && row.code === 'budget')); assert.equal(provider.vendorCalls, 1);
  assert.ok(!(await provider.describe()).ok);
});
