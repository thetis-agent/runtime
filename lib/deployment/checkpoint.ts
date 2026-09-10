/** Persist neutral recovery metadata without resolved secrets or inherited credentials; ADR 0012, ADR 0019. */
import { mkdir, readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWrite } from '../files/atomic.ts';
import { readBounded } from '../files/read-bounded.ts';
import { failure, isObject } from '../schema/index.ts';
import type { Result, Schemas, Validator } from '../schema/index.ts';
import { validators } from '../evaluation/index.ts';
import type { Checkpoint } from '../generation-state/types.ts';
import { relocateCheckpoint } from './relocation.ts';
export type { Checkpoint } from '../generation-state/types.ts';
export const checkpointLimits = { bytes: 1048576 };

export async function checkpointValidator(schemas: Schemas): Promise<Validator<Checkpoint>> {
  const deployment: unknown = JSON.parse(await readFile(new URL('./schema.json', import.meta.url), 'utf8'));
  const state: unknown = JSON.parse(await readFile(new URL('../generation-state/schema.json', import.meta.url), 'utf8'));
  if (!isObject(deployment) || !isObject(state)) throw new Error('The committed recovery schemas are invalid.');
  validators(schemas); schemas.compile(deployment);
  return schemas.compile<Checkpoint>({ ...state, $id: 'thetis://internal/deployment/checkpoint', $ref: '#/$defs/checkpoint' });
}

export function neutralCheckpoint(input: unknown): unknown {
  if (!isObject(input) || !isObject(input['target']) || !isObject(input['target']['revision']) || !isObject(input['target']['revision']['plan'])) return input;
  const target = input['target']; const revision = input['target']['revision']; const plan = input['target']['revision']['plan'];
  const clean = Object.fromEntries(['name', 'version', 'entry', 'args', 'cwd', 'network', 'execution'].filter(key => plan[key] !== undefined).map(key => [key, plan[key]]));
  const profile = target['profile']; const runtime = isObject(profile) ? profile['runtime'] : undefined;
  return { ...input, target: { ...target, revision: { ...revision, plan: clean }, ...(isObject(profile) && isObject(runtime) ? { profile: { ...profile, runtime: { ...runtime, token: 'inherited-at-start' } } } : {}) } };
}

function path(root: string, target: string): string { return join(root, `${createHash('sha256').update(target).digest('hex')}.json`); }

export async function hasCheckpoint(root: string, target: string): Promise<Result<boolean>> {
  try { return { ok: true, value: (await lstat(path(root, target))).isFile() }; }
  catch (error) { return isObject(error) && error['code'] === 'ENOENT' ? { ok: true, value: false } : failure('io', 'The recovery checkpoint could not be inspected.'); }
}

export async function saveCheckpoint(root: string, input: unknown, schemas: Schemas): Promise<Result<void>> {
  const value = neutralCheckpoint(input); const check = await checkpointValidator(schemas);
  if (!check(value)) return failure('invalid-args', 'The recovery checkpoint violates its schema.');
  const bytes = Buffer.from(JSON.stringify(value)); if (bytes.length > checkpointLimits.bytes) return failure('budget', 'The recovery checkpoint exceeds its byte limit.');
  try { await mkdir(root, { recursive: true, mode: 0o700 }); return await atomicWrite(path(root, value.target.id), bytes); }
  catch { return failure('io', 'The recovery checkpoint could not be committed.'); }
}

export async function loadCheckpoint(root: string, target: string, schemas: Schemas): Promise<Result<Checkpoint>> {
  const bytes = await readBounded(path(root, target), checkpointLimits.bytes); if (!bytes.ok) return bytes;
  let value: unknown;
  try { value = JSON.parse(bytes.value.toString('utf8')); } catch { return failure('invalid-args', 'The recovery checkpoint has invalid JSON.'); }
  const check = await checkpointValidator(schemas);
  return check(value) && value.target.id === target ? relocateCheckpoint(resolve(root, '../..'), value) : failure('invalid-args', 'The recovery checkpoint violates its schema or target identity.');
}
