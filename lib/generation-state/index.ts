/** Recover only durable observed state; candidate rows cannot select pins or a recovery epoch; ADR 0014, ADR 0025. */
import { readFile } from 'node:fs/promises';
import { fileFrames } from '@/lib/ndjson/file.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Result, Schemas } from '@/lib/schema/index.ts';
import type { Row, View } from './types.ts';
export type { Generation, View } from './types.ts';

export async function recover(path: string, target: string, schemas: Schemas): Promise<Result<View | undefined>> {
  const raw: unknown = JSON.parse(await readFile(new URL('./schema.json', import.meta.url), 'utf8'));
  if (!isObject(raw)) throw new Error('The committed generation recovery schema is invalid.');
  const row = schemas.compile<Row>({ ...raw, $id: 'thetis://internal/generation-state/row', $ref: '#/$defs/row' });
  const state = schemas.compile<View>(raw); let latest: View | undefined;
  for await (const frame of fileFrames(path)) {
    if (!frame.ok) return frame;
    if (!row(frame.value)) return failure('invalid-args', 'The generation journal row violates its schema.');
    if (frame.value.provenance !== 'kernel-observed' || frame.value.target !== target || !['generation.transition', 'generation.initial'].includes(frame.value.kind)) continue;
    const value = frame.value.data['snapshot'];
    if (!state(value)) return failure('invalid-args', 'The observed generation snapshot violates its schema.');
    if (latest && value.current.n < latest.current.n) return failure('fenced', 'The observed generation journal decreases its epoch.');
    latest = value;
  }
  return { ok: true, value: latest };
}
