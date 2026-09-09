/** Bound SSE framing without buffering a completion or accepting malformed UTF-8; PR-003–004. */
import { failure } from '../../lib/schema/index.ts';
import type { Result } from '../../lib/schema/index.ts';

class Framing {
  line = '';
  data: string[] = [];
  bytes = 0;
  cr = false;
  readonly maximum: number;
  constructor(maximum: number) { this.maximum = maximum; }
  *feed(text: string): Generator<Result<string, 'provider'>> {
    for (const character of text) {
      if (this.cr && character === '\n') { this.cr = false; continue; }
      this.cr = character === '\r';
      if (character !== '\n' && character !== '\r') {
        this.bytes += Buffer.byteLength(character);
        if (this.bytes > this.maximum) { yield failure('provider', 'The vendor event exceeds its byte limit.'); return; }
        this.line += character; continue;
      }
      if (this.line === '') {
        if (this.data.length > 0) yield { ok: true, value: this.data.join('\n') };
        this.data = []; this.bytes = 0;
      } else if (this.line.startsWith('data:')) this.data.push(this.line.slice(this.line[5] === ' ' ? 6 : 5));
      else if (this.line === 'data') this.data.push('');
      this.line = '';
    }
  }
}

export async function* sse(source: AsyncIterable<Uint8Array>, maximum = 1024 * 1024): AsyncGenerator<Result<string, 'provider'>> {
  const decoder = new TextDecoder('utf-8', { fatal: true }); const framing = new Framing(maximum);
  try {
    for await (const chunk of source) for (const result of framing.feed(decoder.decode(chunk, { stream: true }))) {
      yield result; if (!result.ok) return;
    }
    for (const result of framing.feed(decoder.decode())) { yield result; if (!result.ok) return; }
    if (framing.line || framing.data.length) yield failure('provider', 'The vendor stream ended inside an SSE event.');
  } catch { yield failure('provider', 'The vendor stream could not be read as UTF-8.'); }
}
