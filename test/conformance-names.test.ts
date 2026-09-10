/** Ensure comments, skipped declarations and dynamic tables cannot falsify the inventory; ADR 0006. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { declarations } from './conformance-names.ts';
import { inventory } from './conformance-inventory.ts';
await test('Conformance inventory counts actual names and expanded static table declarations', () => {
  const source = "import test from 'node:test';\n// TE-999 is only a comment.\nawait test('TE-001 real',()=>{});\nfor(const [id,code] of [['PR-008',401],['PR-009',429]] satisfies [string,number][]) test(`${id} error ${code}`,()=>{});\ntest.skip('KS-999 skipped',()=>{});";
  const found = declarations(source, 'fixture.ts');
  assert.deepEqual(found.map(item => item.name.slice(0, 6)), ['TE-001', 'PR-008', 'PR-009', 'KS-999']);
  assert.equal(found.at(-1)?.skipped, true); assert.equal(found[0]?.line, 3);
});

await test('Every specified conformance id has an enabled executable test declaration', async () => {
  const result = await inventory(new URL('..', import.meta.url).pathname);
  assert.deepEqual(result.missing, [], 'Conformance ids without tests');
  assert.deepEqual(result.skipped, [], 'Conformance ids cannot be skipped without a record');
});
