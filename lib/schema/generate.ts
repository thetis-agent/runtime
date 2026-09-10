/** Keep contract types subordinate to schemas, including open fields; ADR 0006. */
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { posix } from 'node:path';
import { packagesRoot } from '../profile/packages-root.ts';
import { generateSupport } from '../artifacts/generate.ts';
import { precompile } from './precompile.ts';

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

/** `&` binds tighter than `|` in TypeScript, so a union member of an intersection must be
 * parenthesized or the intersection silently narrows only its first alternative. */
function intersected(member: unknown): string {
  const rendered = render(member);
  const union = object(member)['oneOf'] ?? object(member)['anyOf'];
  return Array.isArray(union) && union.length > 1 ? `(${rendered})` : rendered;
}

export function render(value: unknown): string {
  if (value === false) return 'never';
  const schema = object(value);
  if (typeof schema['$ref'] === 'string') return reference(schema['$ref']);
  if ('const' in schema) return JSON.stringify(schema['const']);
  if (Array.isArray(schema['enum'])) return schema['enum'].map(item => JSON.stringify(item)).join(' | ');
  const union = schema['oneOf'] ?? schema['anyOf'];
  if (Array.isArray(union)) return union.map(render).join(' | ');
  const intersection = schema['allOf'];
  if (Array.isArray(intersection)) return intersection.map(intersected).join(' & ');
  const kind = schema['type'];
  if (Array.isArray(kind)) return kind.map((item: unknown) => render({ ...schema, type: item })).join(' | ');
  if (kind === 'object') return members(schema);
  if (kind === 'array') return `(${render(schema['items'])})[]`;
  if (kind === 'integer' || kind === 'number') return 'number';
  if (kind === 'string' || kind === 'boolean' || kind === 'null') return kind;
  return 'unknown';
}

export async function generate(name: string, root = new URL('../../contracts/', import.meta.url)): Promise<string> {
  const raw: unknown = JSON.parse(await readFile(new URL(`${name}/schema.json`, root), 'utf8'));
  const schema = object(raw);
  const defs = object(schema['$defs']);
  const category = root.href === new URL('../../contracts/', import.meta.url).href ? 'contracts'
    : root.href === new URL('../../lib/', import.meta.url).href ? 'lib' : 'packages';
  const imports = new Set<string>();
  const serialized = JSON.stringify(raw);
  for (const match of serialized.matchAll(/thetis:\/\/(contract|internal)\/([^/]+)\/\d+#/gu)) {
    const kind = match[1]; const target = match[2];
    if (!target) continue;
    const directory = kind === 'contract' ? '../../contracts/' : '../../lib/';
    const destination = new URL(`${directory}${target}/types.ts`, import.meta.url);
    if (destination.href === new URL(`${name}/types.ts`, root).href) continue;
    const path = posix.relative(`${category}/${name}`, `${kind === 'contract' ? 'contracts' : 'lib'}/${target}/types.ts`);
    imports.add(`import type * as ${title(target)} from '${path.startsWith('.') ? path : `./${path}`}';`);
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
  let fresh = true;
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  for (const root of [new URL('../../contracts/', import.meta.url), new URL('../../lib/', import.meta.url), pathToFileURL(`${packagesRoot(repo)}/`)]) {
    for (const name of await readdir(root)) {
      const folder = new URL(`${name}/`, root);
      try { if (!(await stat(folder)).isDirectory()) continue; } catch { continue; }
      if (!(await readdir(folder)).includes('schema.json')) continue;
      const generated = await generate(name, root);
      const path = new URL(`${name}/types.ts`, root);
      if (check) fresh = (await readFile(path, 'utf8')) === generated && fresh;
      else await writeFile(path, generated);
    }
  }
  return await generateSupport(check) && await precompile(check) && fresh;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!await generateAll(process.argv.includes('--check'))) process.exitCode = 1;
}
