/** Validate once at the process edge, preserving unknown fields; ADR 0006 §4. */
import { Ajv2020 } from 'ajv/dist/2020.js';
import { readFile } from 'node:fs/promises';
import type { ValidateFunction } from 'ajv';
export type { ValidateFunction as Validator } from 'ajv';

import { failure, isObject } from '../result/index.ts';
import type { Result } from '../result/index.ts';
export { failure, isObject } from '../result/index.ts';
export type { Result } from '../result/index.ts';

export class Schemas {
  readonly #ajv = new Ajv2020({ strict: false, strictNumbers: true, allErrors: false, validateFormats: false });
  #loading: Promise<void> | undefined;

  load(): Promise<void> {
    this.#loading ??= this.#load();
    return this.#loading;
  }

  async #load(): Promise<void> {
    for (const name of ['provider', 'turn-events', 'skills', 'kernel-socket']) {
      const value: unknown = JSON.parse(await readFile(new URL(`../../contracts/${name}/schema.json`, import.meta.url), 'utf8'));
      if (!isObject(value)) throw new Error(`Invalid committed schema: ${name}`);
      this.#ajv.addSchema(value);
    }
  }

  validator<T>(contract: string, definition: string): ValidateFunction<T> {
    const check = this.#ajv.getSchema<T>(`thetis://contract/${contract}/1#/$defs/${definition}`);
    if (!check) throw new Error(`Missing schema: ${contract}/${definition}`);
    return check;
  }

  arguments(schema: Record<string, unknown>, value: unknown): boolean {
    return this.#ajv.validate(schema, value);
  }

  compile<T>(schema: Record<string, unknown>): ValidateFunction<T> {
    const id = schema['$id']; const cached = typeof id === 'string' ? this.#ajv.getSchema<T>(id) : undefined;
    return cached ?? this.#ajv.compile<T>(schema);
  }

  frame<T>(): ValidateFunction<T> {
    const cached = this.#ajv.getSchema<T>('thetis://entry/kernel-socket/1'); if (cached) return cached;
    const base = 'thetis://contract/kernel-socket/1';
    const source: unknown = this.#ajv.getSchema(base)?.schema;
    if (!isObject(source) || !isObject(source['$defs']) || !isObject(source['$defs']['params'])) throw new Error('The socket parameter schemas are missing.');
    const constraints = Object.keys(source['$defs']['params']).map(method => ({
      if: { allOf: [{ $ref: `${base}#/$defs/request` }, { properties: { method: { const: method } } }] },
      then: { properties: { params: { $ref: `${base}#/$defs/params/${method}` } } }
    }));
    return this.#ajv.compile<T>({ $id: 'thetis://entry/kernel-socket/1', allOf: [{ $ref: `${base}#/$defs/frame` }, ...constraints] });
  }
}

export function decode<T>(check: ValidateFunction<T>, value: unknown): Result<T, 'invalid-args'> {
  return check(value) ? { ok: true, value } : failure('invalid-args', 'The frame does not match its contract.');
}
