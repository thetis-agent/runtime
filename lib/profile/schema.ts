/** Validate installation descriptions without evaluating package code; ADR 0006, GN-002. */
import { readFile } from 'node:fs/promises';
import { isObject } from '../schema/index.ts';
import type { Schemas, Validator } from '../schema/index.ts';
export async function validator<T>(schemas: Schemas, definition: string): Promise<Validator<T>> {
  const registry: unknown = JSON.parse(await readFile(new URL('../../contracts/registry/schema.json', import.meta.url), 'utf8'));
  const profile: unknown = JSON.parse(await readFile(new URL('./schema.json', import.meta.url), 'utf8'));
  if (!isObject(registry) || !isObject(profile)) throw new Error('The committed installation schemas are invalid.');
  schemas.compile(registry);
  return schemas.compile<T>({ ...profile, $id: `thetis://internal/profile/${definition}`, $ref: `#/$defs/${definition}` });
}
