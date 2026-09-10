/** Compare every generated guard with its authoritative schema and defend altered root references; ADR 0006, ADR 0037. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import compiled from './compiled.cjs';
import { signature } from './precompile.ts';
import { Schemas, isObject } from './index.ts';

await test('ADR 0037 every generated definition agrees with runtime Ajv on deterministic boundary values', async () => {
  const ajv = new Ajv2020({ strict: false, strictNumbers: true, validateFormats: false, inlineRefs: false }); const documents: Record<string, unknown>[] = [];
  for (const root of [new URL('../../contracts/', import.meta.url), new URL('../../lib/', import.meta.url)]) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !(await readdir(new URL(`${entry.name}/`, root))).includes('schema.json')) continue;
      const document: unknown = JSON.parse(await readFile(new URL(`${entry.name}/schema.json`, root), 'utf8')); assert.ok(isObject(document));
      documents.push(document); ajv.addSchema(document);
    }
  }
  const samples: unknown[] = [undefined, null, false, true, -1, 0, 1, NaN, Infinity, '', 'hello', [], [null], {}, { extension: true }, { cost: -1 }, { cost: Infinity }, { ok: true, value: null }, { id: '1', method: 'session.submit', params: {} }, { id: '1', method: 'health.probe', params: { extension: true } }];
  let definitions = 0;
  for (const document of documents) {
    const id = document['$id']; assert.ok(typeof id === 'string'); const hash = signature(document); const fragments = [''];
    if (isObject(document['$defs'])) for (const [name, value] of Object.entries(document['$defs'])) {
      if (name === 'params' && isObject(value)) fragments.push(...Object.keys(value).map(method => `/$defs/params/${method}`));
      else fragments.push(`/$defs/${name}`);
    }
    for (const fragment of fragments) {
      const expected: ValidateFunction | undefined = ajv.getSchema(`${id}#${fragment}`); const actual = compiled(`${hash}#${fragment}`); assert.ok(expected && actual); definitions++;
      for (const sample of samples) assert.equal(actual(sample), expected(sample), `${id}#${fragment}: ${JSON.stringify(sample)}`);
    }
  }
  assert.ok(definitions > 100);
});

await test('ADR 0037 generated shortcuts never ignore changed root constraints or foreign references', async () => {
  const schemas = new Schemas(); await schemas.load();
  const document: unknown = JSON.parse(await readFile(new URL('../../contracts/provider/schema.json', import.meta.url), 'utf8')); assert.ok(isObject(document));
  const constrained = schemas.compile({ ...document, $id: 'thetis://test/constrained', const: 'impossible' }); assert.equal(constrained({ type: 'stop', reason: 'end' }), false);
  const referenced: unknown = JSON.parse(await readFile(new URL('../../contracts/turn-events/schema.json', import.meta.url), 'utf8')); assert.ok(isObject(referenced));
  const foreign = schemas.compile({ ...referenced, $id: 'thetis://test/foreign', $ref: 'thetis://contract/turn-events/1#/$defs/input' });
  assert.equal(foreign({ text: 'hello', attachments: [] }), true); assert.equal(foreign({ type: 'stop', reason: 'end' }), false);
  const unreferenced = Object.fromEntries(Object.entries(referenced).filter(([key]) => key !== '$ref'));
  assert.ok(schemas.compile({ ...unreferenced, $id: 'thetis://test/unreferenced' })({ arbitrary: true }));
  assert.throws(() => schemas.precompiled(document, 'incorrect', () => true), /stale/u);
  const changed = new Schemas(); assert.ok(isObject(document['$defs']));
  changed.compile({ ...document, $defs: { ...document['$defs'], content: { const: 'changed contract' } } }); await changed.load();
  assert.equal(changed.validator('turn-events', 'message')({ role: 'user', content: [{ type: 'text', text: 'not the changed contract' }], source: 'test' }), false);
});
