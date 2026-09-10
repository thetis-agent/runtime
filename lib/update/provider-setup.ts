/** Validate initial provider settings and seal its key through kernel secret custody; PR-013. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Secrets } from '@/kernel/secrets/index.ts';
import { Schemas, isObject } from '@/lib/schema/index.ts';
import { readBounded } from '@/lib/files/read-bounded.ts';
import type { ModelCap } from '@/contracts/provider/types.ts';
import type { Principal } from '@/kernel/identity/index.ts';
import { money, decimal } from '@/lib/provider/money.ts';

export interface ProviderSetup { endpoint: string; model: ModelCap; dailyBudget: number }
const limits = { configurationBytes: 65536, catalogBytes: 4194304, keyBytes: 16384, deadlineMs: 30000 };

export async function readProvider(path: string, schemas: Schemas): Promise<ProviderSetup> {
  const bytes = await readBounded(path, limits.configurationBytes);
  if (!bytes.ok) throw new Error(bytes.error.message);
  const value: unknown = JSON.parse(bytes.value.toString('utf8'));
  const valid = schemas.compile<ProviderSetup>({ type: 'object', required: ['endpoint', 'model', 'dailyBudget'], properties: {
    endpoint: { type: 'string', maxLength: 4096 }, model: { $ref: 'thetis://contract/provider/1#/$defs/modelCap' },
    dailyBudget: { type: 'number', exclusiveMinimum: 0 }
  } });
  if (!valid(value)) throw new Error('Provider configuration needs endpoint, model capabilities and a positive dailyBudget.');
  const url = new URL(value.endpoint); const price = value.model.price;
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('The provider endpoint must be HTTPS without credentials, query or fragment.');
  if (!value.model.tools || value.model.images || value.model.cache === 'explicit') throw new Error('Choose a text model with tools and implicit or no caching.');
  if (!price || typeof price.in !== 'number' || typeof price.out !== 'number' ||
    Object.values(price).some(amount => typeof amount === 'number' && (!Number.isFinite(amount) || amount < 0))) throw new Error('Declare nonnegative input and output prices per million tokens.');
  if ((value.model.contextWindow * Math.max(price.in, price.cachedRead ?? price.in, price.cachedWrite ?? price.in) + value.model.maxOutput * price.out) / 1000000 > value.dailyBudget) {
    throw new Error('The daily budget cannot reserve one full request; reduce the configured context/output limits or increase dailyBudget.');
  }
  return value;
}

/** OpenRouter publishes capabilities and per-token prices; do not guess either. */
export async function openRouter(model: string, dailyBudget: number): Promise<ProviderSetup> {
  const response = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(limits.deadlineMs), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('The OpenRouter model catalog could not be downloaded.');
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limits.catalogBytes) throw new Error('The model catalog exceeds its size limit.');
    chunks.push(chunk);
  }
  const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const models: unknown[] = isObject(data) && Array.isArray(data.data) ? data.data : [];
  const selected = models.find(row => isObject(row) && row.id === model);
  if (!isObject(selected) || !isObject(selected.pricing) || typeof selected.context_length !== 'number') throw new Error('The requested model is absent from the OpenRouter catalog.');
  const parameters: unknown[] = Array.isArray(selected.supported_parameters) ? selected.supported_parameters : [];
  if (!parameters.includes('tools')) throw new Error('The selected model does not support tools.');
  const maximum = isObject(selected.top_provider) && typeof selected.top_provider.max_completion_tokens === 'number' ? selected.top_provider.max_completion_tokens : 4096;
  const contextWindow = Math.min(selected.context_length, 32768);
  const price = catalogPrice(selected.pricing, contextWindow);
  return { endpoint: 'https://openrouter.ai/api/v1/chat/completions', dailyBudget,
    model: { id: model, contextWindow, maxOutput: Math.min(maximum, 4096),
      tools: true, images: false, seed: parameters.includes('seed'), cache: 'implicit', price } };
}

function tokenRate(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number' || typeof value === 'string' && !value.trim()) throw new Error('The selected model does not publish usable token prices.');
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('The selected model does not publish usable token prices.');
  const rate = Number(decimal(money(amount) * 1000000n));
  if (!Number.isFinite(rate)) throw new Error('The selected model does not publish usable token prices.');
  return rate;
}

/** Reserve against every price tier reachable inside the configured context window. */
function catalogPrice(pricing: Record<string, unknown>, contextWindow: number): NonNullable<ModelCap['price']> {
  const tiers = [pricing];
  if (pricing['overrides'] !== undefined && !Array.isArray(pricing['overrides'])) throw new Error('The model price tiers are invalid.');
  for (const tier of Array.isArray(pricing['overrides']) ? pricing['overrides'] : []) {
    if (!isObject(tier) || typeof tier['min_prompt_tokens'] !== 'number' || !Number.isSafeInteger(tier['min_prompt_tokens']) || tier['min_prompt_tokens'] < 0) throw new Error('The model price tiers are invalid.');
    if (tier['min_prompt_tokens'] <= contextWindow) tiers.push({ ...pricing, ...tier });
  }
  const price: NonNullable<ModelCap['price']> & { in: number; out: number } = { in: 0, out: 0 };
  for (const tier of tiers) {
    price.in = Math.max(price.in, tokenRate(tier['prompt']));
    price.out = Math.max(price.out, tokenRate(tier['completion']));
    if (tier['input_cache_read'] !== undefined) price.cachedRead = Math.max(price.cachedRead ?? 0, tokenRate(tier['input_cache_read']));
    if (tier['input_cache_write'] !== undefined) price.cachedWrite = Math.max(price.cachedWrite ?? 0, tokenRate(tier['input_cache_write']));
  }
  return price;
}

async function sealKey(state: string, masterPath: string, operator: string): Promise<void> {
  const master = await readFile(masterPath); const chunks: Buffer[] = []; let size = 0;
  try {
    for await (const raw of process.stdin) {
      const chunk: unknown = raw;
      if (!Buffer.isBuffer(chunk) || (size += chunk.length) > limits.keyBytes) throw new Error('The API key exceeds its size limit.');
      chunks.push(chunk);
    }
    const key = Buffer.concat(chunks);
    try {
      if (!key.length || master.length !== 32) throw new Error('The API key or master key is missing or invalid.');
      const secrets = await Secrets.open(join(state, 'kernel/sealed'), master);
      if (!secrets.ok) throw new Error(secrets.error.message);
      const principal: Principal = { id: operator, role: 'admin', projects: [], observeOthers: true };
      const stored = await secrets.value.set(principal, 'kernel', { scope: 'deployment', name: 'llm-key', value: key.toString('utf8') });
      if (!stored.ok) throw new Error(stored.error.message);
    } finally { key.fill(0); }
  } finally { master.fill(0); for (const chunk of chunks) chunk.fill(0); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [command, first = '', second = '', third = ''] = process.argv.slice(2);
    const schemas = new Schemas(); await schemas.load();
    if (command === 'openrouter') {
      await writeFile(third, `${JSON.stringify(await openRouter(first, Number(second)))}\n`, { mode: 0o600 });
      await readProvider(third, schemas);
    } else if (command === 'check') { await readProvider(first, schemas); }
    else if (command === 'seal') { await sealKey(first, second, third); }
    else throw new Error('Unknown provider setup command.');
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Provider setup failed.'}\n`); process.exitCode = 1; }
}
