/** Keep committed package guards independent of the surrounding build; ADR 0006, ADR 0035, ADR 0037. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { schemaOutput } from '@/lib/artifacts/schema-output.ts';
import { packageGuard } from './precompile.ts';

const unrelated = { $id: 'thetis://test/unrelated/1', $defs: { first: { type: 'string' } }, $ref: '#/$defs/first' };
const widened = { ...unrelated, $defs: { first: { type: ['string', 'number'] }, second: { type: 'boolean' } } };
const leaf = { $id: 'thetis://test/leaf/1', $defs: { value: { type: 'number', minimum: 0 } } };
const dependency = { $id: 'thetis://test/dependency/1', $ref: `${leaf.$id}#/$defs/value` };
const dependent = { $id: 'thetis://test/dependent/1', type: 'object', required: ['value'], properties: { value: { $ref: dependency.$id } }, additionalProperties: true };

async function validator(code: string): Promise<(value: unknown) => boolean> {
  const root = await mkdtemp('/tmp/package-validator-');
  try {
    const path = join(root, 'guard.cjs'); await writeFile(path, code);
    const validate: unknown = createRequire(import.meta.url)(path); assert.ok(typeof validate === 'function');
    return (value: unknown): boolean => Reflect.apply(validate, undefined, [value]) === true;
  } finally { await rm(root, { recursive: true, force: true }); }
}

await test('ADR 0035 unrelated schema additions, removals and widening cannot change a package guard', () => {
  const schema = { $id: 'thetis://test/package/1', $defs: { value: { type: 'string' } }, $ref: '#/$defs/value' };
  const expected = packageGuard(schema);
  for (const documents of [[unrelated], [widened], [leaf, dependency, widened], []]) {
    assert.deepEqual(packageGuard(schema, documents), expected);
  }
  packageGuard(dependent, [leaf, dependency]);
  assert.deepEqual(packageGuard(schema), expected, 'compiling another package must not affect subsequent output');
});

await test('ADR 0035 referenced guards ignore unrelated schemas and their registration order', () => {
  const expected = packageGuard(dependent, [leaf, dependency]);
  for (const documents of [[unrelated, leaf, dependency], [dependency, widened, leaf], [dependency, leaf]]) {
    assert.deepEqual(packageGuard(dependent, documents), expected);
  }
});

await test('ADR 0006 standalone package guards retain transitive references and detect actual dependency changes', async () => {
  const [original] = packageGuard(dependent, [leaf, dependency]);
  const changedLeaf = { ...leaf, $defs: { value: { type: 'number', minimum: 5 } } };
  const [changed] = packageGuard(dependent, [changedLeaf, dependency]);
  assert.notEqual(original, changed);
  const validate = await validator(original); const changedValidate = await validator(changed);
  assert.ok(validate({ value: 0, extension: true })); assert.equal(changedValidate({ value: 0 }), false);
  assert.ok(changedValidate({ value: 5, extension: true }));
  for (const sample of [null, {}, { value: -1 }, { value: '5' }, { value: NaN }, { value: Infinity }]) {
    assert.equal(validate(sample), false); assert.equal(changedValidate(sample), false);
  }
  assert.throws(() => packageGuard(dependent, [dependency]), /can't resolve reference/u);
});

await test('ADR 0037 committed package guards equal isolated edited-package generation', async () => {
  const packages = new URL('../../packages/', import.meta.url);
  let checked = 0;
  for (const entry of await readdir(packages, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const folder = new URL(`${entry.name}/`, packages);
    if (!(await readdir(folder)).includes('schema.json')) continue;
    const root = await mkdtemp('/tmp/package-guard-');
    try {
      await copyFile(new URL('schema.json', folder), join(root, 'schema.json'));
      await schemaOutput(root);
      for (const file of ['schema-validators.cjs', 'schema-validators.d.cts']) {
        assert.ok(await readFile(join(root, file), 'utf8') === await readFile(new URL(file, folder), 'utf8'), `${entry.name}/${file} depends on the surrounding build`);
      }
      checked++;
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  assert.ok(checked > 0);
});
