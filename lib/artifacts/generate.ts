/** Generate the small trusted preload and schema guard without loading application code; ADR 0037. */
import { readFile, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';
import standalone from 'ajv/dist/standalone/index.js';
import { isObject } from '@/lib/result/index.ts';

export async function generateSupport(check: boolean): Promise<boolean> {
  const schema: unknown = JSON.parse(await readFile(new URL('./schema.json', import.meta.url), 'utf8'));
  if (!isObject(schema)) throw new Error('The committed artifact schema is invalid.');
  const ajv = new Ajv2020({ strict: false, validateFormats: false, code: { source: true, esm: true } }); ajv.addSchema(schema);
  const outputs: [string, string][] = [];
  for (const [name, definition, type] of [['metadata', 'artifact', 'Artifact'], ['job', 'job', 'Job'], ['reply', 'reply', 'Reply']]) {
    if (!name || !definition || !type) throw new Error('The artifact generator lost its definition.');
    const validate = ajv.getSchema(`thetis://internal/artifacts/1#/$defs/${definition}`); if (!validate) throw new Error('The committed artifact definition is missing.');
    outputs.push([`${name}.mjs`, `/** Generated schema guard; ADR 0037. Do not edit. */\n${standalone.default(ajv, validate)}\n`],
      [`${name}.d.mts`, `/** Generated schema guard type; ADR 0037. Do not edit. */\nimport type { ${type} } from './types.ts';\ndeclare const validate: (value: unknown) => value is ${type};\nexport default validate;\n`]);
  }
  outputs.push(['register.mjs', stripTypeScriptTypes(await readFile(new URL('./loader.ts', import.meta.url), 'utf8'), { mode: 'strip' })]);
  for (const [source, output] of [['aliases.ts', 'aliases.mjs'], ['source-loader.ts', 'source.mjs']] satisfies [string, string][]) {
    outputs.push([output, stripTypeScriptTypes(await readFile(new URL(source, import.meta.url), 'utf8'), { mode: 'strip' })]);
  }
  outputs.push(['aliases.d.mts', "/** Generated resolution types; ADR 0047. Do not edit. */\nexport { rootImport } from './aliases.ts';\n"]);
  outputs.push(['verify.mjs', stripTypeScriptTypes(await readFile(new URL('./verify.ts', import.meta.url), 'utf8'), { mode: 'strip' })],
    ['verify.d.mts', "/** Generated bootstrap types; ADR 0037. Do not edit. */\nexport { verified, limits } from './verify.ts';\n"]);
  let fresh = true;
  for (const [name, output] of outputs) {
    const path = new URL(name, import.meta.url);
    if (check) { try { fresh = await readFile(path, 'utf8') === output && fresh; } catch { fresh = false; } }
    else await writeFile(path, output);
  }
  return fresh;
}
