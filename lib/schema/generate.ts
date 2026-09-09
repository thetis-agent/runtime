/** Keep contract types subordinate to schemas, including open fields; ADR 0006. */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value));
}

function title(name: string): string {
  return name.split(/[^a-zA-Z0-9]+/u).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('');
}

function reference(ref: string): string {
  const [base, fragment] = ref.split('#');
  const name = fragment?.split('/').at(-1);
  if (!name) throw new Error(`Schema reference has no definition: ${ref}`);
  if (!base) return title(name);
  const contract = base.split('/').at(-2);
  if (!contract) throw new Error(`Schema reference has no contract: ${ref}`);
  return `${title(contract)}.${title(name)}`;
}

function members(schema: ObjectValue): string {
  const properties = object(schema['properties']);
  const required = new Set(Array.isArray(schema['required']) ? schema['required'] : []);
  const keys = new Set([...Object.keys(properties), ...required].filter((key): key is string => typeof key === 'string'));
  const fields = [...keys].map(key => `${JSON.stringify(key)}${required.has(key) ? '' : '?'}: ${render(properties[key] ?? schema['additionalProperties'])};`);
  if (schema['additionalProperties'] !== false) fields.push(`[key: string]: ${render(schema['additionalProperties'])};`);
  return `{ ${fields.join(' ')} }`;
}

function render(value: unknown): string {
  if (value === false) return 'never';
  const schema = object(value);
  if (typeof schema['$ref'] === 'string') return reference(schema['$ref']);
  if ('const' in schema) return JSON.stringify(schema['const']);
  if (Array.isArray(schema['enum'])) return schema['enum'].map(item => JSON.stringify(item)).join(' | ');
  const union = schema['oneOf'] ?? schema['anyOf'];
  if (Array.isArray(union)) return union.map(render).join(' | ');
  const intersection = schema['allOf'];
  if (Array.isArray(intersection)) return intersection.map(render).join(' & ');
  const kind = schema['type'];
  if (Array.isArray(kind)) return kind.map((item: unknown) => render({ ...schema, type: item })).join(' | ');
  if (kind === 'object') return members(schema);
  if (kind === 'array') return `(${render(schema['items'])})[]`;
  if (kind === 'integer' || kind === 'number') return 'number';
  if (kind === 'string' || kind === 'boolean' || kind === 'null') return kind;
  return 'unknown';
}

export async function generate(name: string): Promise<string> {
  const raw: unknown = JSON.parse(await readFile(new URL(`../../contracts/${name}/schema.json`, import.meta.url), 'utf8'));
  const schema = object(raw);
  const defs = object(schema['$defs']);
  const imports = new Set<string>();
  const serialized = JSON.stringify(raw);
  for (const match of serialized.matchAll(/thetis:\/\/contract\/([^/]+)\/\d+#/gu)) {
    const contract = match[1];
    if (contract && contract !== name) imports.add(`import type * as ${title(contract)} from '../${contract}/types.ts';`);
  }
  const lines = ['/** Generated from schema.json; defend wire compatibility (ADR 0006). Do not edit. */', ...imports];
  for (const [key, value] of Object.entries(defs)) {
    if (key === 'params') {
      for (const [method, params] of Object.entries(object(value))) lines.push(`export type ${title(method)}Params = ${render(params)};`);
    } else lines.push(`export type ${title(key)} = ${render(value)};`);
  }
  lines.push(`export type Contract = ${render(schema)};`, '');
  return lines.join('\n');
}

export async function generateAll(check: boolean): Promise<boolean> {
  const root = new URL('../../contracts/', import.meta.url);
  let fresh = true;
  for (const name of await readdir(root)) {
    const generated = await generate(name);
    const path = new URL(`${name}/types.ts`, root);
    if (check) fresh = (await readFile(path, 'utf8')) === generated && fresh;
    else await writeFile(path, generated);
  }
  return fresh;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!await generateAll(process.argv.includes('--check'))) process.exitCode = 1;
}
