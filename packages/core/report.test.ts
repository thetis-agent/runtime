/** Pin bounded diagnostic aggregation and prevent payloads or late rows entering another turn; ADR 0014, ADR 0019. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnReport, reportLimits } from './report.ts';
import { isObject } from '../../lib/schema/index.ts';

await test('ADR-0019 token observations become one counted diagnostic row without token content', () => {
  const report = new TurnReport();
  for (let index = 0; index < 10000; index++) report.stage({ source: 'gateway', event: 'token', outcome: 'ok', elapsed: 2 });
  report.call(1, 'read_path', { id: 'call', ok: false, error: { code: 'invalid-args', message: 'private arguments' }, content: [{ type: 'text', text: 'private result' }] }, 4);
  const result = report.finish('conversation', 1, { reason: 'answer', iterations: 1, compactions: 0 }); assert.ok(result.ok);
  const rows = result.value['stages']; assert.ok(Array.isArray(rows)); assert.equal(rows.length, 1);
  const row: unknown = rows[0]; assert.ok(isObject(row)); assert.equal(row['count'], 10000); assert.equal(row['elapsed'], 20000);
  assert.ok(!JSON.stringify(result).includes('private'));
  report.stage({ source: 'late', event: 'token', outcome: 'observer-throw', elapsed: 4 });
  assert.ok(!JSON.stringify(result).includes('late'));
});

await test('ADR-0014 a diagnostic report refuses overflow instead of silently dropping stage rows', () => {
  const report = new TurnReport();
  for (let index = 0; index < reportLimits.rows + 1; index++) report.stage({ source: `stage-${String(index)}`, event: 'offer', outcome: 'ok', elapsed: 1 });
  const result = report.finish('conversation', 1, { reason: 'crash', iterations: 1, compactions: 0 });
  assert.ok(!result.ok); assert.equal(result.error.code, 'budget'); assert.equal(result.error.message, 'The turn report exceeds its byte limit.');
});

await test('ADR-0019 oversized diagnostic identifiers retain a digest within the byte limit', () => {
  const report = new TurnReport();
  report.call(1, 'x'.repeat(10000), { id: 'y'.repeat(10000), ok: true }, 0);
  const result = report.finish('conversation', 1, { reason: 'answer', iterations: 1, compactions: 0 }); assert.ok(result.ok);
  assert.ok(JSON.stringify(result).includes('sha256:')); assert.ok(Buffer.byteLength(JSON.stringify(result)) < reportLimits.bytes);
});

await test('ADR-0014 retrieval and offer diagnostics refuse excessive lists before copying identifiers', () => {
  const entry = { id: 'skill', pack: 'pack', version: '1.0.0', path: 'skill.md', contentHash: 'a'.repeat(64), universal: false };
  const tool = { name: 'read', description: 'Read', schema: {}, readOnly: true, endsTurn: false, source: 'files' };
  const retrieved = new TurnReport(); retrieved.retrieve(1, Array.from({ length: reportLimits.rows + 1 }, () => entry));
  const offered = new TurnReport(); offered.offer(1, Array.from({ length: reportLimits.rows + 1 }, () => tool));
  for (const report of [retrieved, offered]) {
    const result = report.finish('conversation', 1, { reason: 'crash', iterations: 1, compactions: 0 });
    assert.ok(!result.ok); assert.equal(result.error.code, 'budget');
  }
});
