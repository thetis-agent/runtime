/** Preserve normalized message order and opaque reasoning at the vendor edge; PR-002, PR-005–007. */
import type { Message, ModelCap, RequestEvent } from '../../contracts/provider/types.ts';
import type { Result } from '../../lib/schema/index.ts';
import { failure, isObject } from '../../lib/schema/index.ts';

function message(source: Message): Result<Record<string, unknown>, 'context'> {
  const content: Record<string, unknown>[] = []; const calls: Record<string, unknown>[] = []; const details: unknown[] = [];
  let reasoning = '';
  for (const part of source.content) {
    switch (part.type) {
      case 'text': content.push({ type: 'text', text: part.text }); break;
      case 'reasoning': {
        reasoning += part.text ?? '';
        if (isObject(part.opaque) && Array.isArray(part.opaque['reasoning_details'])) { const preserved: unknown[] = part.opaque['reasoning_details']; details.push(...preserved); }
        break;
      }
      case 'tool_call': calls.push({ id: part.id, type: 'function', function: { name: part.name, arguments: part.args } }); break;
      case 'artifact': case 'resource': content.push({ type: 'text', text: JSON.stringify(part) }); break;
      case 'image': return failure('context', 'This provider has no registered image transfer capability.');
    }
  }
  const result: Record<string, unknown> = { role: source.role, content };
  if (source.toolCallId !== undefined) result['tool_call_id'] = source.toolCallId;
  if (calls.length) result['tool_calls'] = calls;
  if (details.length) result['reasoning_details'] = details;
  else if (reasoning) result['reasoning'] = reasoning;
  return { ok: true, value: result };
}

function markers(messages: Record<string, unknown>[], stride: number, maximum: number): Result<void, 'context'> {
  const anchors = new Set<number>();
  const system = messages.findLastIndex(value => value['role'] === 'system'); if (system >= 0) anchors.add(system);
  for (let index = stride - 1; index < messages.length; index += stride) anchors.add(index);
  if (messages.length) anchors.add(messages.length - 1);
  if (anchors.size > maximum) return failure('context', 'The cache policy exceeds the vendor breakpoint limit.');
  for (const index of anchors) {
    const parts: unknown = messages[index]?.['content'];
    if (!Array.isArray(parts)) continue;
    const last: unknown = parts.at(-1); if (isObject(last)) last['cache_control'] = { type: 'ephemeral' };
  }
  return { ok: true, value: undefined };
}

export function vendorRequest(frames: readonly RequestEvent[], model: ModelCap, cacheMarkers = 4): Result<Record<string, unknown>, 'context'> {
  const begin = frames[0]; if (begin?.type !== 'begin') throw new Error('The normalized request lost begin.');
  const messages: Record<string, unknown>[] = []; const tools: Record<string, unknown>[] = [];
  for (const frame of frames) {
    if (frame.type === 'message') { const mapped = message(frame); if (!mapped.ok) return mapped; messages.push(mapped.value); }
    if (frame.type === 'tool') tools.push({ type: 'function', function: { name: frame.name, description: frame.description, parameters: frame.schema } });
  }
  if (tools.length && !model.tools) return failure('context', 'The selected model does not support tools.');
  if (model.cache === 'explicit' && begin.cache) {
    const marked = markers(messages, begin.cache.anchorStride ?? 32, cacheMarkers); if (!marked.ok) return marked;
  }
  const body: Record<string, unknown> = { model: model.id, messages, stream: true, stream_options: { include_usage: true }, max_tokens: Math.min(begin.options?.maxTokens ?? model.maxOutput, model.maxOutput) };
  if (tools.length) body['tools'] = tools;
  if (begin.options?.temperature !== undefined) body['temperature'] = begin.options.temperature;
  if (begin.options?.seed !== undefined && model.seed) body['seed'] = begin.options.seed;
  if (begin.options?.stop !== undefined) body['stop'] = begin.options.stop;
  const vendor: unknown = begin.vendor?.['provider-openai-compatible'];
  if (isObject(vendor) && isObject(vendor['reasoning'])) body['reasoning'] = vendor['reasoning'];
  return { ok: true, value: body };
}
