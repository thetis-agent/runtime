/** Stream line ranges and bounded directory walks into the core's sink; TE-016, TE-018. */
import { opendir } from 'node:fs/promises';
import { join, matchesGlob, relative } from 'node:path';
import { fileChunks } from '../../lib/ndjson/file.ts';
import type { SpillSink } from '../../lib/spill/index.ts';
import type { Result } from '../../lib/schema/index.ts';
import { failure } from '../../lib/schema/index.ts';

export const limits = { entries: 10000, depth: 32, lineBytes: 1048576, results: 1000 };

export async function readLines(path: string, sink: SpillSink, offset = 1, limit = 200): Promise<Result<void>> {
  let line = 1;
  for await (const chunk of fileChunks(path)) {
    let start = -1;
    for (let i = 0; i < chunk.length; i++) {
      if (line >= offset && start === -1) start = i;
      if (chunk[i] === 10) line++;
      if (line >= offset + limit) {
        return start >= 0 ? sink.write(chunk.subarray(start, i + 1)) : { ok: true, value: undefined };
      }
    }
    if (start >= 0) { const written = await sink.write(chunk.subarray(start)); if (!written.ok) return written; }
  }
  return { ok: true, value: undefined };
}

export async function list(path: string, sink: SpillSink): Promise<Result<void>> {
  let count = 0;
  for await (const entry of await opendir(path)) {
    if (++count > limits.entries) return failure('budget', 'The directory listing exceeds 10000 entries.');
    const written = await sink.write(Buffer.from(`${entry.name}${entry.isDirectory() ? '/' : ''}\n`));
    if (!written.ok) return written;
  }
  return { ok: true, value: undefined };
}

export async function* walk(path: string, depth = 0, budget = { remaining: limits.entries }): AsyncGenerator<Result<string>> {
  if (depth > limits.depth) { yield failure('budget', 'The directory walk exceeds its depth limit.'); return; }
  for await (const entry of await opendir(path)) {
    if (--budget.remaining < 0) { yield failure('budget', 'The directory walk exceeds its entry limit.'); return; }
    if (entry.isDirectory()) yield* walk(join(path, entry.name), depth + 1, budget);
    else if (entry.isFile()) yield { ok: true, value: join(path, entry.name) };
    if (budget.remaining < 0) return;
  }
}

export async function find(path: string, glob: string, maximum: number, sink: SpillSink): Promise<Result<void>> {
  let count = 0;
  for await (const found of walk(path)) {
    if (!found.ok) return found;
    const file = found.value;
    if (!matchesGlob(relative(path, file), glob)) continue;
    const written = await sink.write(Buffer.from(`${file}\n`)); if (!written.ok) return written;
    if (++count >= maximum) break;
  }
  return { ok: true, value: undefined };
}
