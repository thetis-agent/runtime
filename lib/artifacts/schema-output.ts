/** Regenerate edited package guards as schema data, never package evaluation; ADR 0006, ADR 0037. */
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { packageGuard } from '@/lib/schema/precompile.ts';
import { readBounded } from '@/lib/files/read-bounded.ts';
import { isObject } from '@/lib/result/index.ts';
const limits = { schemaBytes: 1048576, directories: 256, totalBytes: 67108864 };
export async function schemaOutput(root: string, previous?: string): Promise<void> {
  if (!(await readdir(root)).includes('schema.json')) return;
  const source = await readBounded(join(root, 'schema.json'), limits.schemaBytes); if (!source.ok) throw new Error(source.error.message);
  if (previous) {
    const original = await readBounded(join(previous, 'schema.json'), limits.schemaBytes);
    if (original.ok && source.value.equals(original.value)) {
      const code = await readBounded(join(previous, 'schema-validators.cjs'), limits.schemaBytes);
      const declaration = await readBounded(join(previous, 'schema-validators.d.cts'), limits.schemaBytes);
      if (code.ok && declaration.ok) { await writeFile(join(root, 'schema-validators.cjs'), code.value); await writeFile(join(root, 'schema-validators.d.cts'), declaration.value); return; }
    }
  }
  const schema: unknown = JSON.parse(source.value.toString('utf8')); if (!isObject(schema)) throw new Error('The edited package schema is invalid.');
  const ajv = new Ajv2020({ strict: false, strictNumbers: true, validateFormats: false, inlineRefs: false, code: { source: true } }); let bytes = source.value.length;
  for (const directory of [new URL('../../contracts/', import.meta.url), new URL('../../lib/', import.meta.url)]) {
    const entries = await readdir(directory, { withFileTypes: true }); if (entries.length > limits.directories) throw new Error('The committed schema directory exceeds its entry budget.');
    for (const entry of entries) {
      const root = fileURLToPath(new URL(`${entry.name}/`, directory));
      if (!entry.isDirectory() || !(await readdir(root)).includes('schema.json')) continue;
      const document = await readBounded(join(root, 'schema.json'), limits.schemaBytes); if (!document.ok) throw new Error(document.error.message);
      if ((bytes += document.value.length) > limits.totalBytes) throw new Error('The committed schemas exceed their byte budget.');
      const value: unknown = JSON.parse(document.value.toString('utf8')); if (!isObject(value)) throw new Error('A committed schema is invalid.'); ajv.addSchema(value);
    }
  }
  const [code, declaration] = packageGuard(ajv, schema);
  if (Buffer.byteLength(code) > limits.schemaBytes) throw new Error('The generated package guard exceeds its byte budget.');
  await writeFile(join(root, 'schema-validators.cjs'), code); await writeFile(join(root, 'schema-validators.d.cts'), declaration);
}
