/** Defend generated types and unknown-field compatibility; ADR 0006, PR-005. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate, generateAll } from './generate.ts';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Schemas, decode } from './index.ts';
import type { ResponseEvent } from '@/contracts/provider/types.ts';

await test('ADR-0006 committed types exactly match every contract schema', async () => {
  assert.equal(await generateAll(true), true);
});

await test('ADR 0035 generated package references are identical in a relocated registry', async () => {
  const root = await mkdtemp('/tmp/generated-registry-');
  try {
    await mkdir(join(root, 'provider-mock'));
    await copyFile(new URL('../../packages/provider-mock/schema.json', import.meta.url), join(root, 'provider-mock/schema.json'));
    const expected = await generate('provider-mock', new URL('../../packages/', import.meta.url));
    const relocated = await generate('provider-mock', pathToFileURL(`${root}/`));
    assert.equal(relocated, expected);
    assert.ok(relocated.includes("'@/contracts/provider/types.ts'"));
    assert.ok(!relocated.includes(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('Provider schema preserves unknown fields and rejects negative cost', async () => {
  const schemas = new Schemas();
  await schemas.load();
  const validate = schemas.validator<ResponseEvent>('provider', 'responseEvent');
  const frame = { type: 'usage', counters: { cost: 0, fresh_counter: 12 }, future: { enabled: true } };
  const result = decode(validate, frame);
  assert.deepEqual(result, { ok: true, value: frame });
  assert.equal(decode(validate, { type: 'usage', counters: { cost: -1 } }).ok, false);
  assert.equal(decode(validate, { type: 'usage', counters: { cost: Infinity } }).ok, false);
});

await test('KS-021 lazy parameter validators retain frame discrimination and ignore response extensions', async () => {
  const schemas = new Schemas(); await schemas.load(); const frame = schemas.frame();
  assert.ok(frame({ id: 'response', ok: true, result: {}, method: 'unknown/extension', params: { extension: true } }));
  assert.ok(frame({ note: 'notice', params: { message: 'hello' }, method: 'health.probe' }));
  assert.equal(frame({ id: 'request', method: 'session.submit', params: {} }), false);
  assert.ok(frame({ id: 'request', method: 'health.probe', params: { extension: true }, extension: 'kept' }));
});
