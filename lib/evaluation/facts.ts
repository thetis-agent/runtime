/** Separate reviewed usage from candidate diagnostics when assembling an evaluation row; ADR 0014, ADR 0020. */
import { fileFrames } from '../ndjson/file.ts';
import { failure } from '../result/index.ts';
import type { Schemas } from '../schema/index.ts';
import schema from '../../contracts/evaluator/schema.json' with { type: 'json' };
import type { Diagnostic, JournalRow } from '../../contracts/evaluator/types.ts';
import type { Candidate } from './runtime-types.ts';
export const factLimits = { bytes: 67108864, rows: 100000, counters: 256 };

export async function facts(path: string, target: string, diagnostic: unknown, schemas: Schemas): ReturnType<Candidate['facts']> {
  schemas.compile(schema); const check = schemas.compile<JournalRow>({ $ref: `${schema.$id}#/$defs/journalRow` }); const report = schemas.compile<Diagnostic>({ $ref: `${schema.$id}#/$defs/diagnostic` });
  const counters: Record<string, number> = {};
  try {
    for await (const frame of fileFrames(path, { ...factLimits, frameBytes: 65536 })) {
      if (!frame.ok) return frame;
      if (!check(frame.value)) return failure('invalid-args', 'The evaluation log row violates its schema.');
      const row = frame.value;
      if (row.provenance === 'candidate-reported' && row.kind === 'turn.report' && row.target === target) diagnostic = row.data;
      if (row.provenance !== 'reviewed-reported' || row.kind !== 'usage.report' || row.target !== target) continue;
      for (const [name, value] of Object.entries(row.data.counters ?? {})) {
        const total = (counters[name] ?? 0) + value;
        if (!Number.isFinite(total)) return failure('budget', 'The evaluation usage counters overflowed.');
        counters[name] = total;
      }
      if (Object.keys(counters).length > factLimits.counters) return failure('budget', 'The evaluation usage counter limit is exhausted.');
    }
  } catch { return failure('io', 'The evaluation facts could not be read.'); }
  const final = diagnostic; const valid = report(final);
  return { ok: true, value: { counters, iterations: valid ? final.end.iterations : 0, dropped: valid ? final.dropped ?? 0 : 0, end: valid ? { reason: final.end.reason } : { reason: 'crash' } } };
}
