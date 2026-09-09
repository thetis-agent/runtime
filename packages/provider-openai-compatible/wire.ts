/** Validate vendor chunks once and normalize accounting without exposing vendor error bodies; PR-003, PR-008–009. */
import type { ResponseEvent, ModelCap } from '../../contracts/provider/types.ts';
import type { Result, Schemas } from '../../lib/schema/index.ts';
import { failure, isObject } from '../../lib/schema/index.ts';

const optionalText = { type: ['string', 'null'] };
const amount = { type: 'number', minimum: 0 };
const schema = { type: 'object', properties: {
  error: { type: 'object', properties: { code: { type: ['string', 'number'] } } },
  choices: { type: 'array', maxItems: 1, items: { type: 'object', properties: {
    finish_reason: optionalText,
    delta: { type: 'object', properties: {
      content: optionalText, reasoning: optionalText, reasoning_content: optionalText,
      reasoning_details: { type: ['array', 'null'], maxItems: 1024, items: { type: 'object' } },
      tool_calls: { type: 'array', maxItems: 64, items: { type: 'object', required: ['index'], properties: {
        index: { type: 'integer', minimum: 0, maximum: 63 }, id: { type: 'string', maxLength: 256 },
        function: { type: 'object', properties: { name: { type: 'string', maxLength: 256 }, arguments: { type: 'string' } } }
      } } }
    } }
  } } },
  usage: { type: ['object', 'null'], properties: {
    cost: amount, prompt_tokens: amount, completion_tokens: amount,
    prompt_tokens_details: { type: 'object', properties: { cached_tokens: amount, cache_write_tokens: amount } },
    completion_tokens_details: { type: 'object', properties: { reasoning_tokens: amount } }
  } }
}, anyOf: [{ required: ['choices'] }, { required: ['error'] }, { required: ['usage'] }] };

export function chunk(text: string, schemas: Schemas): Result<Record<string, unknown>, 'provider'> {
  try { const value: unknown = JSON.parse(text); return schemas.arguments(schema, value) && isObject(value) ? { ok: true, value } : failure('provider', 'The vendor event violates its schema.'); }
  catch { return failure('provider', 'The vendor event is not valid JSON.'); }
}

export function error(status: number): Extract<ResponseEvent, { type: 'error' }> {
  const code = status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate-limit' : status === 402 ? 'budget' : status === 413 ? 'context' : status === 408 || status === 504 ? 'deadline' : 'provider';
  return { type: 'error', code, status, message: `The vendor refused the request with status ${String(status)}.` };
}

function number(value: unknown): number { return typeof value === 'number' ? value : 0; }

export function usage(value: Record<string, unknown>, model: ModelCap): Result<Extract<ResponseEvent, { type: 'usage' }>, 'provider'> {
  const input = number(value['prompt_tokens']); const output = number(value['completion_tokens']);
  const details = value['prompt_tokens_details']; const reasoning = value['completion_tokens_details'];
  const cached = isObject(details) ? number(details['cached_tokens']) : 0;
  const write = isObject(details) ? number(details['cache_write_tokens']) : 0;
  let cost = value['cost'];
  if (cost === undefined) {
    if (typeof value['prompt_tokens'] !== 'number' || typeof value['completion_tokens'] !== 'number') return failure('provider', 'The vendor omitted the token counts needed for accounting.');
    const price = model.price;
    if (price?.in === undefined || price.out === undefined) return failure('provider', 'The vendor omitted cost and this model has no accounting prices.');
    cost = (Math.max(0, input - cached - write) * price.in + output * price.out + cached * (price.cachedRead ?? price.in) + write * (price.cachedWrite ?? price.in)) / 1000000;
  }
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return failure('provider', 'The vendor cost is invalid.');
  return { ok: true, value: { type: 'usage', counters: { cost, in: input, out: output, cached, cached_write: write, reasoning: isObject(reasoning) ? number(reasoning['reasoning_tokens']) : 0 } } };
}
