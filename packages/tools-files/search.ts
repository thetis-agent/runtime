/** Bound searches by traversed entries and line bytes while forwarding matches; TE-018. */
import { matchesGlob, relative } from 'node:path';
import { fileChunks } from '../../lib/ndjson/file.ts';
import { failure } from '../../lib/schema/index.ts';
import type { Result } from '../../lib/schema/index.ts';
import type { SpillSink } from '../../lib/spill/index.ts';
import { walk, limits } from './read.ts';

async function* lines(path: string): AsyncGenerator<Result<string>> {
  let pending = Buffer.alloc(0);
  for await (const chunk of fileChunks(path)) {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 10) continue;
      if (pending.length + i - start > limits.lineBytes) { yield failure('budget', 'The search line exceeds its byte budget.'); return; }
      yield { ok: true, value: Buffer.concat([pending, chunk.subarray(start, i)]).toString('utf8') };
      pending = Buffer.alloc(0); start = i + 1;
    }
    if (pending.length + chunk.length - start > limits.lineBytes) { yield failure('budget', 'The search line exceeds its byte budget.'); return; }
    pending = Buffer.concat([pending, chunk.subarray(start)]);
  }
  if (pending.length) yield { ok: true, value: pending.toString('utf8') };
}

export async function search(path: string, args: Record<string, unknown>, sink: SpillSink): Promise<Result<void>> {
  const pattern = typeof args['pattern'] === 'string' ? args['pattern'] : '';
  const glob = typeof args['glob'] === 'string' ? args['glob'] : '**/*';
  const maximum = typeof args['max_results'] === 'number' ? args['max_results'] : limits.results;
  let count = 0;
  for await (const found of walk(path)) {
    if (!found.ok) return found;
    const file = found.value;
    if (!matchesGlob(relative(path, file), glob)) continue;
    let matches = 0; let number = 0;
    for await (const line of lines(file)) {
      if (!line.ok) return line;
      number++;
      if (!line.value.includes(pattern)) continue;
      matches++;
      if (args['mode'] === 'files') break;
      if (args['mode'] === 'count') continue;
      const written = await sink.write(Buffer.from(`${file}:${String(number)}:${line.value}\n`)); if (!written.ok) return written;
      if (++count >= maximum) return { ok: true, value: undefined };
    }
    if (matches && (args['mode'] === 'files' || args['mode'] === 'count')) {
      const written = await sink.write(Buffer.from(`${file}${args['mode'] === 'count' ? `:${String(matches)}` : ''}\n`)); if (!written.ok) return written;
      if (++count >= maximum) break;
    }
  }
  return { ok: true, value: undefined };
}
