/** Validate once at the process edge, preserving unknown fields; ADR 0006 §4. */
import { Ajv2020 } from 'ajv/dist/2020.js';
import { readFile } from 'node:fs/promises';
import type { ValidateFunction } from 'ajv';

export type Result<T, C extends string = string> =
  | { ok: true; value: T }
  | { ok: false; error: { code: C; message: string } };

export function failure<C extends string>(code: C, message: string): { ok: false; error: { code: C; message: string } } {
  return { ok: false, error: { code, message } };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class Schemas {
  readonly #ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: false });

  async load(): Promise<void> {
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
}

export function decode<T>(check: ValidateFunction<T>, value: unknown): Result<T, 'invalid-args'> {
  return check(value) ? { ok: true, value } : failure('invalid-args', 'The frame does not match its contract.');
}
