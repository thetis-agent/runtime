/** Refuse authentication failures without disclosing partial plaintext; ADR 0034, KS-008. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seal, unseal, sealedLimits } from './sealed.ts';
await test('KS-008 sealed bytes authenticate their selected identity and key without retaining either', () => {
  const key = Buffer.alloc(32, 1); const value = 'private byte sequence';
  const sealed = seal(key, 'selected-identity', value); assert.ok(sealed.ok);
  assert.ok(!sealed.value.includes(value)); const opened = unseal(key, 'selected-identity', sealed.value);
  assert.ok(opened.ok); assert.equal(opened.value.toString(), value); opened.value.fill(0);
  assert.ok(!unseal(Buffer.alloc(32, 2), 'selected-identity', sealed.value).ok);
  assert.ok(!unseal(key, 'other-identity', sealed.value).ok);
  for (const bytes of [Buffer.from('{}'), Buffer.from('invalid JSON'), Buffer.alloc(sealedLimits.envelopeBytes + 1)]) assert.ok(!unseal(key, 'selected-identity', bytes).ok);
  assert.ok(!seal(Buffer.alloc(31), 'selected-identity', value).ok);
  assert.ok(!seal(key, 'selected-identity', 'x'.repeat(sealedLimits.plaintextBytes + 1)).ok);
  assert.deepEqual(key, Buffer.alloc(32, 1));
});
