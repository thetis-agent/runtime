/** Validate once at the process edge, preserving unknown fields; ADR 0006 §4. */
import type { Ajv2020 } from 'ajv/dist/2020.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import compiled from './compiled.cjs';
import create from './compiler.cjs';
export type Validator<T = unknown> = (value: unknown) => value is T;

import { failure, isObject } from '@/lib/result/index.ts';
import type { Result } from '@/lib/result/index.ts';
export { failure, isObject } from '@/lib/result/index.ts';
export type { Result } from '@/lib/result/index.ts';

export class Schemas {
  #instance: Ajv2020 | undefined;
  readonly #documents = new Map<string, Record<string, unknown>>();
  readonly #roots = new Map<string, { hash: string; root: string }>();
  #loading: Promise<void> | undefined;
  get #ajv(): Ajv2020 {
    if (!this.#instance) {
      this.#instance = create(this.#documents.values());
    }
    return this.#instance;
  }
  #register(schema: Record<string, unknown>): { hash: string; root: string } {
    const hash = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$id' && key !== '$ref')))).digest('hex');
    const root = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$id')))).digest('hex');
    const id = schema['$id'];
    if (typeof id === 'string' && !this.#documents.has(id)) { this.#documents.set(id, schema); this.#roots.set(id, { hash, root }); this.#instance?.addSchema(schema); }
    return { hash, root };
  }
  #known<T>(hash: string, fragment: string): Validator<T> | undefined {
    const validate = compiled(`${hash}${fragment}`, this.#roots); return validate ? (value: unknown): value is T => validate(value) : undefined;
  }
  #reference<T>(reference: string): Validator<T> | undefined {
    const [base, fragment = ''] = reference.split('#'); const key = base ? this.#roots.get(base) : undefined;
    return (key ? this.#known<T>(fragment ? key.hash : key.root, fragment ? `#${fragment}` : '@') : undefined) ?? this.#ajv.getSchema<T>(reference);
  }

  load(): Promise<void> {
    this.#loading ??= this.#load();
    return this.#loading;
  }

  async #load(): Promise<void> {
    for (const name of ['provider', 'turn-events', 'skills', 'kernel-socket']) {
      const value: unknown = JSON.parse(await readFile(new URL(`../../contracts/${name}/schema.json`, import.meta.url), 'utf8'));
      if (!isObject(value)) throw new Error(`Invalid committed schema: ${name}`);
      this.#register(value);
    }
  }

  validator<T>(contract: string, definition: string): Validator<T> {
    const check = this.#reference<T>(`thetis://contract/${contract}/1#/$defs/${definition}`);
    if (!check) throw new Error(`Missing schema: ${contract}/${definition}`);
    return check;
  }

  arguments(schema: Record<string, unknown>, value: unknown): boolean {
    if (!Object.keys(schema).length) return true;
    return this.#ajv.validate(schema, value);
  }

  precompiled<T>(schema: Record<string, unknown>, digest: string, validate: (value: unknown) => boolean): Validator<T> {
    if (this.#register(schema).root !== digest) throw new Error('The generated package schema validator is stale.');
    return (value: unknown): value is T => validate(value);
  }

  compile<T>(schema: Record<string, unknown>): Validator<T> {
    const key = this.#register(schema); const reference = schema['$ref'];
    const fast = this.#known<T>(key.root, '@') ?? (typeof reference === 'string' && reference.startsWith('#') && Object.keys(schema).every(name => ['$schema', '$id', '$defs', '$ref'].includes(name)) ? this.#known<T>(key.hash, reference) : undefined); if (fast) return fast;
    if (Object.keys(schema).length === 1 && typeof reference === 'string') { const known = this.#reference<T>(reference); if (known) return known; }
    const id = schema['$id']; const cached = typeof id === 'string' ? this.#ajv.getSchema<T>(id) : undefined;
    return cached ?? this.#ajv.compile<T>(schema);
  }

  definition<T>(schema: Record<string, unknown>, definition: string): Validator<T> {
    const id = schema['$id']; if (typeof id !== 'string') throw new Error('The committed schema has no identifier.');
    const reference = `${id}#/$defs/${definition}`;
    const fast = this.#known<T>(this.#register(schema).hash, `#/$defs/${definition}`); if (fast) return fast;
    const cached = this.#ajv.getSchema<T>(reference); if (cached) return cached;
    const check = this.#ajv.getSchema<T>(reference);
    if (!check) throw new Error(`Missing schema definition: ${id}/${definition}`);
    return check;
  }

  frame<T>(): Validator<T> {
    const base = 'thetis://contract/kernel-socket/1';
    const frame = this.#reference<T>(`${base}#/$defs/frame`);
    const request = this.#reference<Record<string, unknown>>(`${base}#/$defs/request`);
    if (!frame || !request) throw new Error('The socket frame schema is missing.');
    const check = (value: unknown): value is T => {
      if (!frame(value)) return false;
      if (!request(value) || !isObject(value) || typeof value['id'] !== 'string' || typeof value['method'] !== 'string' || !isObject(value['params'])) return true;
      const params = this.#reference<Record<string, unknown>>(`${base}#/$defs/params/${value['method']}`);
      if (params && '$async' in params) throw new Error('The socket parameter schema must be synchronous.');
      return params ? params(value['params']) : true;
    };
    return check;
  }

}

export function decode<T>(check: Validator<T>, value: unknown): Result<T, 'invalid-args'> {
  return check(value) ? { ok: true, value } : failure('invalid-args', 'The frame does not match its contract.');
}
