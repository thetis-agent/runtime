/** Move committed-schema compilation to the checked release step without weakening validation; ADR 0006, ADR 0037. */
import { readFile, writeFile, readdir, mkdir, unlink } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import standalone from 'ajv/dist/standalone/index.js';
import { createHash } from 'node:crypto';
import { isObject } from '@/lib/result/index.ts';
import { packagesRoot } from '@/lib/profile/packages-root.ts';
import { fileURLToPath, pathToFileURL } from 'node:url';
export function signature(schema: Record<string, unknown>, root = false): string {
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$id' && (root || key !== '$ref'))))).digest('hex');
}
export async function precompile(check: boolean): Promise<boolean> {
  const ajv = new Ajv2020({ strict: false, strictNumbers: true, validateFormats: false, inlineRefs: false, code: { source: true } });
  const documents: Record<string, unknown>[] = [];
  for (const root of [new URL('../../contracts/', import.meta.url), new URL('../../lib/', import.meta.url)]) {
    for (const entry of (await readdir(root, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !(await readdir(new URL(`${entry.name}/`, root))).includes('schema.json')) continue;
      const value: unknown = JSON.parse(await readFile(new URL(`${entry.name}/schema.json`, root), 'utf8'));
      if (!isObject(value) || typeof value['$id'] !== 'string') throw new Error('The committed schema has no identifier.');
      ajv.addSchema(value); documents.push(value);
    }
  }
  const index: Record<string, string> = {}; const dependencies: Record<string, [string, string][]> = {}; const outputs: [URL, string][] = [];
  for (const document of documents) {
    const references: Record<string, string> = {};
    const id = document['$id']; if (typeof id !== 'string') throw new Error('The schema identifier disappeared.');
    const hash = signature(document); references[`${hash}#`] = id;
    references[`${signature(document, true)}@`] = id;
    const definitions = document['$defs'];
    if (isObject(definitions)) for (const [name, definition] of Object.entries(definitions)) {
      if (name === 'params' && isObject(definition)) {
        for (const method of Object.keys(definition)) references[`${hash}#/$defs/params/${method}`] = `${id}#/$defs/params/${method}`;
      } else references[`${hash}#/$defs/${name}`] = `${id}#/$defs/${name}`;
    }
    for (const key of Object.keys(references)) { index[key] = hash; dependencies[key] = referencesFor(document, documents); }
    outputs.push([new URL(`./compiled/${hash}.cjs`, import.meta.url), `/** Generated committed-schema validators; ADR 0006, ADR 0037. Do not edit. */\n${standalone.default(ajv, references)}\n`]);
  }
  const output = `/** Generated lazy validator index; ADR 0006, ADR 0037. Do not edit. */\nconst files = ${JSON.stringify(index)};\nconst dependencies = ${JSON.stringify(dependencies)};\nmodule.exports = function lookup(key, known) { const file = files[key]; if (!file || known && !dependencies[key].every(([id, hash]) => known.get(id)?.root === hash)) return undefined; return require(\`./compiled/\${file}.cjs\`)[key]; };\n`;
  outputs.push([new URL('./compiled.cjs', import.meta.url), output], [new URL('./compiled.d.cts', import.meta.url), '/** Generated validator types; ADR 0006, ADR 0037. Do not edit. */\ndeclare function lookup(key: string, known?: ReadonlyMap<string, { root: string }>): ((value: unknown) => boolean) | undefined;\nexport = lookup;\n']);
  outputs.push(...await packages(documents));
  outputs.push([new URL('./compiler.cjs', import.meta.url), '/** Generated lazy dynamic-schema compiler; ADR 0037. Do not edit. */\nmodule.exports = function create(documents) { const { Ajv2020 } = require("ajv/dist/2020.js"); const instance = new Ajv2020({ strict: false, strictNumbers: true, allErrors: false, validateFormats: false, inlineRefs: false }); for (const document of documents) instance.addSchema(document); return instance; };\n'],
    [new URL('./compiler.d.cts', import.meta.url), '/** Generated compiler types; ADR 0037. Do not edit. */\nimport type { Ajv2020 } from "ajv/dist/2020.js";\ndeclare function create(documents: Iterable<Record<string, unknown>>): Ajv2020;\nexport = create;\n']);
  if (!check) await mkdir(new URL('./compiled/', import.meta.url), { recursive: true });
  let fresh = true;
  const expected = new Set(Object.values(index).map(hash => `${hash}.cjs`));
  for (const file of await readdir(new URL('./compiled/', import.meta.url))) if (!expected.has(file)) {
    if (!/^[a-f0-9]{64}\.cjs$/u.test(file)) throw new Error('The generated validator directory contains an unexpected file.');
    if (check) fresh = false; else await unlink(new URL(`./compiled/${file}`, import.meta.url));
  }
  for (const [path, value] of outputs) {
    if (check) { try { fresh = await readFile(path, 'utf8') === value && fresh; } catch { fresh = false; } }
    else await writeFile(path, value);
  }
  return fresh;
}

async function packages(documents: Record<string, unknown>[]): Promise<[URL, string][]> {
  const root = pathToFileURL(`${packagesRoot(fileURLToPath(new URL('../..', import.meta.url)))}/`); const outputs: [URL, string][] = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || !(await readdir(new URL(`${entry.name}/`, root))).includes('schema.json')) continue;
    const schema: unknown = JSON.parse(await readFile(new URL(`${entry.name}/schema.json`, root), 'utf8')); if (!isObject(schema)) throw new Error('The committed package schema is invalid.');
    const [code, declaration] = packageGuard(schema, documents);
    outputs.push([new URL(`${entry.name}/schema-validators.cjs`, root), code], [new URL(`${entry.name}/schema-validators.d.cts`, root), declaration]);
  }
  return outputs;
}

export function packageGuard(schema: Record<string, unknown>, documents: Iterable<Record<string, unknown>> = []): [string, string] {
  // Ajv's generated names depend on earlier compilations. Each package owns its
  // compiler so unrelated runtime or package edits cannot stale its output (ADR 0035).
  const ajv = new Ajv2020({ strict: false, strictNumbers: true, validateFormats: false, inlineRefs: false, code: { source: true } });
  for (const document of documents) ajv.addSchema(document);
  const validate = ajv.compile(schema);
  return [`/** Generated package schema guard; ADR 0037. Do not edit. */\n${standalone.default(ajv, validate)}\nmodule.exports.digest = ${JSON.stringify(signature(schema, true))};\n`,
    '/** Generated package schema types; ADR 0037. Do not edit. */\ndeclare const validate: { (value: unknown): boolean; digest: string };\nexport = validate;\n'];
}

function referencesFor(schema: Record<string, unknown>, documents: Record<string, unknown>[]): [string, string][] {
  const result = new Map<string, string>(); const visited = new Set<unknown>([schema['$id']]);
  function visit(document: Record<string, unknown>): void {
    for (const match of JSON.stringify(document).matchAll(/"\$ref":"(thetis:[^"#]+)[^"]*"/gu)) {
      const id = match[1]; if (!id || visited.has(id)) continue; visited.add(id);
      const dependency = documents.find(document => document['$id'] === id); if (!dependency) throw new Error('The generated schema dependency is absent.');
      result.set(id, signature(dependency, true)); visit(dependency);
    }
  }
  visit(schema); return [...result.entries()].sort(([left], [right]) => left.localeCompare(right));
}
