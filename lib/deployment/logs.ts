/** Answer env.logs from the kernel's own observations of one target only; ADR 0014, KS-019, KS-020. */
import { readFile } from 'node:fs/promises';
import { fileFrames } from '@/lib/ndjson/file.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Result, Schemas } from '@/lib/schema/index.ts';
import type { Row } from '@/lib/generation-state/types.ts';

/** A reply is bounded twice: by rows, because a caller may ask for fewer, and by bytes, because a
 * generation snapshot is far larger than a process exit and rows alone do not bound a frame.
 * fileFrames bounds the scan itself (rows, scanned bytes and one row's bytes), so neither an
 * unbounded journal nor one oversized observation can become an unbounded socket reply. */
export const logLimits = { rows: 200, bytes: 262144 };
export interface LogRow { cursor: number; at: number; kind: string; data: Record<string, unknown> }
export interface Logs { target: string; rows: LogRow[]; cursor: number; oldest: number; truncated: boolean }

function count(value: unknown, fallback: number, maximum: number): Result<number> {
  if (value === undefined) return { ok: true, value: fallback };
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return failure('invalid-args', 'The log window must be a non-negative integer.');
  return { ok: true, value: Math.min(value, maximum) };
}

/** Only kernel-observed rows are answered. Reported rows carry note parameters an environment
 * submitted, which may hold provider content, so they stay on the reported half of the journal
 * where the house rule keeps them (ADR 0014; "keep observed and reported logs separate"). */
export async function targetLogs(path: string, target: string, params: Record<string, unknown>, schemas: Schemas): Promise<Result<Logs>> {
  const from = count(params['from'], 0, Number.MAX_SAFE_INTEGER); if (!from.ok) return from;
  const limit = count(params['limit'], logLimits.rows, logLimits.rows); if (!limit.ok) return limit;
  if (limit.value === 0) return failure('invalid-args', 'The log window must admit at least one row.');
  const check = await rowValidator(schemas);
  const kept: LogRow[] = []; let cursor = 0; let bytes = 0; let truncated = false;
  for await (const frame of fileFrames(path)) {
    if (!frame.ok) return frame;
    if (!check(frame.value)) return failure('invalid-args', 'The observed journal row violates its schema.');
    if (frame.value.provenance !== 'kernel-observed' || frame.value.target !== target) continue;
    cursor++;
    if (cursor <= from.value) continue;
    const row = { cursor, at: frame.value.at, kind: frame.value.kind, data: frame.value.data };
    kept.push(row); bytes += Buffer.byteLength(JSON.stringify(row));
    while (kept.length > limit.value || bytes > logLimits.bytes) { const dropped = kept.shift(); if (!dropped) break; bytes -= Buffer.byteLength(JSON.stringify(dropped)); truncated = true; }
  }
  return { ok: true, value: { target, rows: kept, cursor, oldest: kept[0]?.cursor ?? cursor + 1, truncated } };
}

async function rowValidator(schemas: Schemas): Promise<(value: unknown) => value is Row> {
  const raw: unknown = JSON.parse(await readFile(new URL('../generation-state/schema.json', import.meta.url), 'utf8'));
  if (!isObject(raw)) throw new Error('The committed generation recovery schema is invalid.');
  return schemas.definition<Row>(raw, 'row');
}
