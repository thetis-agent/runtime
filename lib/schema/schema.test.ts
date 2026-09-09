/** Defend generated types and unknown-field compatibility; ADR 0006, PR-005. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateAll } from './generate.ts';
import { Schemas, decode } from './index.ts';
import type { ResponseEvent } from '../../contracts/provider/types.ts';

await test('ADR-0006 committed types exactly match every contract schema', async () => {
  assert.equal(await generateAll(true), true);
});

await test('Provider schema preserves unknown fields and rejects negative cost', async () => {
  const schemas = new Schemas();
  await schemas.load();
  const validate = schemas.validator<ResponseEvent>('provider', 'responseEvent');
  const frame = { type: 'usage', counters: { cost: 0, fresh_counter: 12 }, future: { enabled: true } };
  const result = decode(validate, frame);
  assert.deepEqual(result, { ok: true, value: frame });
  assert.equal(decode(validate, { type: 'usage', counters: { cost: -1 } }).ok, false);
});
