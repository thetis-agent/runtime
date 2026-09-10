/** Test the mock against provider obligations rather than a second implementation; PR-014. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerFixture, request, collect, stream } from '@/test/provider-fixture.ts';
import { Schemas } from '@/lib/schema/index.ts';
import type { ResponseEvent } from '../types.ts';

await test('PR-002 repeated pinned prefixes reach the vendor byte-identically', async () => {
  const { provider, token } = providerFixture();
  await collect(provider.run(stream(request()), token, new AbortController().signal));
  await collect(provider.run(stream(request()), token, new AbortController().signal));
  assert.equal(provider.capturedPrefixes.length, 2);
  assert.equal(provider.capturedPrefixes[0], provider.capturedPrefixes[1]);
});

await test('PR-003 usage includes nonnegative cost and precedes stop', async () => {
  const { provider, token } = providerFixture();
  const rows = await collect(provider.run(stream(request()), token, new AbortController().signal));
  const usage = rows.at(-2);
  assert.equal(usage?.type, 'usage');
  assert.ok(usage.counters.cost >= 0);
  assert.deepEqual(rows.at(-1), { type: 'stop', reason: 'end' });
});

await test('PR-004 cancellation stops the stream without later content', async () => {
  const { provider, token } = providerFixture([[{ type: 'delta.text', text: 'first' }, { type: 'delta.text', text: 'forbidden-after-cancel' }]]);
  const controller = new AbortController();
  const rows: ResponseEvent[] = [];
  for await (const row of provider.run(stream(request()), token, controller.signal)) {
    rows.push(row);
    if (row.type === 'delta.text') controller.abort();
  }
  assert.deepEqual(rows.at(-1), { type: 'stop', reason: 'cancel' });
  assert.equal(rows.filter(row => row.type === 'delta.text').length, 1);
});

await test('PR-005 unknown begin and option fields do not change the normalized response', async () => {
  const { provider, token } = providerFixture();
  const schemas = new Schemas(); await schemas.load();
  const validate = schemas.validator<ResponseEvent>('provider', 'responseEvent');
  const rows = await collect(provider.run(stream(request('system', { future: true, options: { future: 1 } })), token, new AbortController().signal));
  assert.ok(rows.every(row => validate(row)));
  assert.equal(rows.at(-1)?.type, 'stop');
});

await test('PR-006 tool fragments share their call id and assemble to schema-valid JSON', async () => {
  const { provider, token } = providerFixture([[
    { type: 'delta.tool_call', callId: 'c', name: 'read_path', args: '{"path":' },
    { type: 'delta.tool_call', callId: 'c', args: '"/space/a"}' }, { type: 'stop', reason: 'tool_calls' }
  ]]);
  const input = request(); input.splice(1, 0, { type: 'tool', name: 'read_path', description: 'Read', schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } });
  const rows = await collect(provider.run(stream(input), token, new AbortController().signal));
  const fragments = rows.filter(row => row.type === 'delta.tool_call');
  assert.ok(fragments.every(row => row.callId === 'c'));
  assert.equal(fragments[0]?.name, 'read_path');
  const args: unknown = JSON.parse(fragments.map(row => row.args).join(''));
  assert.deepEqual(args, { path: '/space/a' });
  assert.deepEqual(rows.at(-1), { type: 'stop', reason: 'tool_calls' });
});

for (const [id, status, code] of [ ['PR-008', 401, 'auth'], ['PR-009', 429, 'rate-limit'] ] satisfies [string, number, 'auth' | 'rate-limit'][]) {
  await test(`${id} vendor refusal is returned once without retry`, async () => {
    const error = { type: 'error', code, status, message: 'Vendor refused.' } satisfies ResponseEvent;
    const { provider, token } = providerFixture([[error]]);
    const rows = await collect(provider.run(stream(request()), token, new AbortController().signal));
    assert.deepEqual(rows.at(-1), error);
    assert.equal(provider.vendorCalls, 1);
  });
}

await test('PR-010 exhausted budgets refuse before vendor access', async () => {
  const { provider, token } = providerFixture([], 0);
  const rows = await collect(provider.run(stream(request()), token, new AbortController().signal));
  assert.deepEqual(rows, [{ type: 'error', code: 'budget', message: 'daily-cost would be exceeded.' }]);
  assert.equal(provider.vendorCalls, 0);
});

await test('PR-011 final counters are attributed to the caller exactly once', async () => {
  const { provider, token, reports } = providerFixture([[{ type: 'usage', counters: { cost: 0.005, custom: 13 } }]]);
  const rows = await collect(provider.run(stream(request()), token, new AbortController().signal));
  assert.deepEqual(reports, [{ token, callId: 'call', counters: { cost: 0.005, custom: 13 } }]);
  assert.deepEqual(rows.at(-2), { type: 'usage', counters: reports[0]?.counters });
});

await test('PR-012 unknown caller credentials never reach the vendor', async () => {
  const { provider } = providerFixture();
  const rows = await collect(provider.run(stream(request()), 'unknown', new AbortController().signal));
  assert.deepEqual(rows, [{ type: 'error', code: 'auth', message: 'The caller is unknown.' }]);
  assert.equal(provider.vendorCalls, 0);
});
