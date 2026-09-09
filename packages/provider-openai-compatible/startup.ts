/** Validate adapter settings separately from the inherited budget and spawn secret; PR-010, PR-013. */
import { fileURLToPath } from 'node:url';
import { readBounded } from '../../lib/files/read-bounded.ts';
import { configured } from '../../lib/schema/settings.ts';
import { failure, isObject } from '../../lib/schema/index.ts';
import type { Schemas, Result } from '../../lib/schema/index.ts';
import type { Clock } from '../../lib/events/index.ts';
import type { Authority, Budgets, Provider } from '../../lib/provider/index.ts';
import { gap } from '../../lib/semver-match/index.ts';
import { create } from './index.ts';
import type { Configuration } from './index.ts';

const identity = { name: 'provider-openai-compatible', version: '1.0.0' };
async function settings(input: Record<string, unknown>, schemas: Schemas): Promise<Result<Omit<Configuration, 'key'>>> {
  const read = await readBounded(fileURLToPath(new URL('./package.json', import.meta.url)), 65536); if (!read.ok) return read;
  const manifest: unknown = JSON.parse(read.value.toString('utf8'));
  if (!isObject(manifest) || !isObject(manifest['settings'])) throw new Error('The committed adapter settings schema is invalid.');
  const values = configured(manifest['settings'], input);
  if (values['models'] === undefined) return failure('gap', gap(identity, 'setting/models', '*'));
  const check = schemas.compile<Omit<Configuration, 'key'>>({ ...manifest['settings'], required: ['endpoint', 'models'] });
  if (!check(values)) return failure('invalid-args', 'The adapter settings violate their schema.');
  if (!URL.canParse(values.endpoint)) return failure('invalid-args', 'The adapter endpoint is not a valid URL.');
  const endpoint = new URL(values.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return failure('invalid-args', 'The adapter endpoint must be HTTPS without credentials or query parameters.');
  if (!values.models.length || values.models.some(model => model.images)) return failure('invalid-args', 'The adapter needs models within its supported capabilities.');
  return { ok: true, value: values };
}

export async function configure(input: Record<string, unknown>, key: string | undefined, authority: Authority, budgets: Budgets, schemas: Schemas, clock: Clock): Promise<Result<Provider>> {
  const config = await settings(input, schemas); if (!config.ok) return config;
  if (!key) return failure('gap', gap(identity, 'secret/llm-key', '*'));
  return { ok: true, value: create({ ...config.value, key }, schemas, clock, authority, budgets) };
}
