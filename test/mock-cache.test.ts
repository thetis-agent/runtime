/** Measure the seeded mock and cache model independently of a real vendor; PR-014. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerFixture, request, collect, stream } from './provider-fixture.ts';

await test('Mock cache serves at least 99 percent of turn two on the long-prefix fixture', async () => {
  const { provider, token } = providerFixture();
  const input = request('Stable prefix. '.repeat(4000));
  const first = await collect(provider.run(stream(input), token, new AbortController().signal));
  const second = await collect(provider.run(stream(input), token, new AbortController().signal));
  const a = first.find(row => row.type === 'usage');
  const b = second.find(row => row.type === 'usage');
  assert.equal(a?.counters['cached'], 0);
  assert.ok(b && (b.counters['cached'] ?? 0) / (b.counters['in'] ?? Infinity) >= 0.99);
});

await test('Mock seeded runs reproduce identical event rows', async () => {
  const a = providerFixture(); const b = providerFixture();
  const input = request('system', { options: { seed: 42 } });
  assert.deepEqual(
    await collect(a.provider.run(stream(input), a.token, new AbortController().signal)),
    await collect(b.provider.run(stream(input), b.token, new AbortController().signal))
  );
});
