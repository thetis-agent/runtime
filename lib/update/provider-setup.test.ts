/** Refuse unusable or unbounded model configurations before installation or secret custody. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Schemas } from '@/lib/schema/index.ts';
import { readProvider, openRouter } from './provider-setup.ts';
import type { ProviderSetup } from './provider-setup.ts';

const schemas = new Schemas(); await schemas.load();
const configuration: ProviderSetup = {
  endpoint: 'https://provider.example/v1/chat/completions', dailyBudget: 1,
  model: { id: 'text-tools', contextWindow: 4096, maxOutput: 512,
    tools: true, images: false, seed: false, cache: 'implicit', price: { in: 1, out: 2 } }
};

await test('provider bootstrap retains exact declared capabilities and prices without needing a key', async () => {
  const root = await mkdtemp('/tmp/provider-setup-'); const path = join(root, 'provider.json');
  try {
    await writeFile(path, JSON.stringify(configuration));
    assert.deepEqual(await readProvider(path, schemas), configuration);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const invalid = {
  'plain HTTP': { ...configuration, endpoint: 'http://provider.example/v1' },
  'embedded credentials': { ...configuration, endpoint: 'https://user:password@provider.example/v1' },
  'query credentials': { ...configuration, endpoint: 'https://provider.example/v1?key=secret' },
  'URL fragment': { ...configuration, endpoint: 'https://provider.example/v1#fragment' },
  'missing budget': { ...configuration, dailyBudget: undefined },
  'zero budget': { ...configuration, dailyBudget: 0 },
  'insufficient reservation': { ...configuration, dailyBudget: 0.001 },
  'missing tools': { ...configuration, model: { ...configuration.model, tools: false } },
  'unsupported images': { ...configuration, model: { ...configuration.model, images: true } },
  'unsupported caching': { ...configuration, model: { ...configuration.model, cache: 'explicit' } },
  'missing prices': { ...configuration, model: { ...configuration.model, price: undefined } },
  'negative prices': { ...configuration, model: { ...configuration.model, price: { in: -1, out: 2 } } },
  'unfunded cache writes': { ...configuration, model: { ...configuration.model, price: { in: 1, out: 2, cachedWrite: 1000 } } },
  'unbounded context': { ...configuration, model: { ...configuration.model, contextWindow: Infinity } }
};
for (const [name, value] of Object.entries(invalid)) await test(`provider bootstrap refuses ${name}`, async () => {
  const root = await mkdtemp('/tmp/provider-refusal-'); const path = join(root, 'provider.json');
  try { await writeFile(path, JSON.stringify(value)); await assert.rejects(readProvider(path, schemas)); }
  finally { await rm(root, { recursive: true, force: true }); }
});

await test('OpenRouter setup preserves cache prices and every reachable context tier', async t => {
  const pricing = { prompt: '0.000002', completion: '0.00001', input_cache_read: '0.0000002', input_cache_write: '0.0000025',
    overrides: [{ min_prompt_tokens: 16384, prompt: '0.000004', completion: '0.000015', input_cache_write: '0.000005' },
      { min_prompt_tokens: 272000, prompt: '1', completion: '1' }] };
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ data: [{ id: 'reviewed', context_length: 1000000,
    supported_parameters: ['tools', 'seed'], top_provider: { max_completion_tokens: 100000 }, pricing }] })));
  const selected = await openRouter('reviewed', 10);
  assert.equal(selected.model.contextWindow, 32768); assert.equal(selected.model.maxOutput, 4096);
  assert.equal(selected.model.seed, true);
  assert.deepEqual(selected.model.price, { in: 4, out: 15, cachedRead: 0.2, cachedWrite: 5 });
  await assert.rejects(openRouter('missing', 10), /absent/u);
  pricing.prompt = '-1'; await assert.rejects(openRouter('reviewed', 10), /usable token prices/u);
});

await test('provider bootstrap refuses oversized settings before parsing', async () => {
  const root = await mkdtemp('/tmp/provider-bounds-'); const path = join(root, 'provider.json');
  try { await writeFile(path, ' '.repeat(65537)); await assert.rejects(readProvider(path, schemas)); }
  finally { await rm(root, { recursive: true, force: true }); }
});
