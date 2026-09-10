/** Publish what the host updater found in one bounded file the deployment may only read; ADR 0048, ADR 0029. */
import { chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWrite } from '@/lib/files/atomic.ts';
import { readBounded } from '@/lib/files/read-bounded.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Result, Schemas } from '@/lib/schema/index.ts';
import type { Policy } from './policy.ts';

export const statusLimits = { fileBytes: 65536 };
export interface Status { version: 1; current: string; available?: string; verified: boolean; checkedAt: number; stagedAt?: number; policy: Policy }

const version = '^v(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)$';
export const statusSchema = {
  type: 'object', required: ['version', 'current', 'verified', 'checkedAt', 'policy'],
  properties: {
    version: { const: 1 }, current: { type: 'string', pattern: version }, available: { type: 'string', pattern: version },
    verified: { type: 'boolean' }, checkedAt: { type: 'integer', minimum: 0 }, stagedAt: { type: 'integer', minimum: 0 },
    policy: { enum: ['none', 'fixes', 'improvements'] },
  },
} as const;

export async function writeStatus(path: string, value: Status): Promise<Result<void>> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > statusLimits.fileBytes) return failure('budget', 'The update status exceeds its byte budget.');
  try { await mkdir(dirname(path), { recursive: true, mode: 0o755 }); } catch { return failure('io', 'The update status directory could not be created.'); }
  const written = await atomicWrite(path, bytes); if (!written.ok) return written;
  try { await chmod(path, 0o644); return written; } catch { return failure('io', 'The update notice could not be made readable by the service.'); }
}

/** An absent file is not a refusal: the timer may simply not have run yet. */
export async function readStatus(path: string, schemas: Schemas): Promise<Result<Status | undefined>> {
  const bytes = await readBounded(path, statusLimits.fileBytes);
  if (!bytes.ok) return bytes.error.code === 'io' ? { ok: true, value: undefined } : bytes;
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.value.toString('utf8')); } catch { return failure('invalid-args', 'The update status file is not valid JSON.'); }
  if (!isObject(parsed)) return failure('invalid-args', 'The update status file is not an object.');
  return schemas.compile<Status>({ ...statusSchema })(parsed) ? { ok: true, value: parsed } : failure('invalid-args', 'The update status file does not match its published shape.');
}
