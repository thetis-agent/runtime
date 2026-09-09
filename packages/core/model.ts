/** Assemble bounded normalized provider events while preserving reasoning; TE-027–028, PR-015. */
import type { Provider } from '../../lib/provider/index.ts';
import type { RequestEvent, ResponseEvent } from '../../contracts/provider/types.ts';
import type { Message } from '../../contracts/turn-events/types.ts';
import type { Result } from '../../lib/schema/index.ts';
import { failure } from '../../lib/schema/index.ts';

export const limits = { outputBytes: 1024 * 1024, calls: 64, callBytes: 1024 * 1024 };
export interface ModelAnswer {
  content: Message['content']; calls: { id: string; name: string; args: string }[];
  usage: Record<string, number>; stop: string;
}

export async function modelExchange(provider: Provider, request: RequestEvent[], token: string, signal: AbortSignal, observe: (event: ResponseEvent) => void): Promise<Result<ModelAnswer, 'provider' | 'budget'>> {
  const answer: ModelAnswer = { content: [], calls: [], usage: {}, stop: 'end' };
  const calls = new Map<string, { id: string; name: string; args: string }>();
  let bytes = 0;
  let text = '';
  for await (const event of provider.run({ async *[Symbol.asyncIterator]() {
    for (const frame of request) { await Promise.resolve(); yield frame; }
  } }, token, signal)) {
    observe(event);
    bytes += Buffer.byteLength(JSON.stringify(event));
    if (bytes > limits.outputBytes) return failure('budget', 'The model response exceeds its byte budget.');
    switch (event.type) {
      case 'start': break;
      case 'delta.text': text += event.text; break;
      case 'delta.reasoning': answer.content.push({ type: 'reasoning', ...(event.text === undefined ? {} : { text: event.text }), ...(event.opaque === undefined ? {} : { opaque: event.opaque }) }); break;
      case 'delta.tool_call': {
        const call = calls.get(event.callId) ?? { id: event.callId, name: event.name ?? '', args: '' };
        if (event.name !== undefined) call.name = event.name;
        call.args += event.args;
        if (calls.size >= limits.calls && !calls.has(call.id) || Buffer.byteLength(call.args) > limits.callBytes) return failure('budget', 'The model tool calls exceed their budget.');
        calls.set(call.id, call); break;
      }
      case 'usage': answer.usage = event.counters; break;
      case 'stop': answer.stop = event.reason; break;
      case 'error': return failure('provider', `${event.code}: ${event.message}`);
    }
  }
  if (text) answer.content.push({ type: 'text', text });
  answer.calls = [...calls.values()];
  return { ok: true, value: answer };
}
