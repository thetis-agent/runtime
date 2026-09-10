/** A person may read the kernel's observations of one environment, never a claim and never without bound; ADR 0014, KS-019. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Schemas } from '@/lib/schema/index.ts';
import { fileLimits } from '@/lib/ndjson/file.ts';
import { targetLogs, logLimits } from './logs.ts';

type Provenance = 'kernel-observed' | 'candidate-reported' | 'reviewed-reported';
function row(target: string, kind: string, data: Record<string, unknown>, provenance: Provenance = 'kernel-observed'): string {
  return `${JSON.stringify({ provenance, at: 1, target, kind, data })}\n`;
}

async function journal(rows: string): Promise<{ path: string; root: string }> {
  const root = await mkdtemp('/tmp/logs-'); const path = join(root, 'observed.jsonl');
  await writeFile(path, rows); return { path, root };
}

await test('env.logs answers only the kernel\'s own observations of the named target', async () => {
  const schemas = new Schemas(); await schemas.load();
  const { path, root } = await journal([
    row('alice', 'process.start', { pid: 1 }),
    row('bob', 'process.start', { pid: 2 }),
    row('alice', 'turn.report', { text: 'a claim an environment submitted' }, 'candidate-reported'),
    row('alice', 'usage.report', { cost: 1 }, 'reviewed-reported'),
    row('alice', 'process.exit', { code: 0 })
  ].join(''));
  try {
    const answer = await targetLogs(path, 'alice', {}, schemas); assert.ok(answer.ok, JSON.stringify(answer));
    assert.deepEqual(answer.value.rows.map(entry => entry.kind), ['process.start', 'process.exit']);
    assert.deepEqual(answer.value.rows.map(entry => entry.cursor), [1, 2]);
    assert.equal(answer.value.cursor, 2); assert.equal(answer.value.oldest, 1); assert.equal(answer.value.truncated, false);
    assert.equal(JSON.stringify(answer.value).includes('a claim an environment submitted'), false);
    const other = await targetLogs(path, 'bob', {}, schemas); assert.ok(other.ok);
    assert.deepEqual(other.value.rows.map(entry => entry.data['pid']), [2]);
    const absent = await targetLogs(path, 'carol', {}, schemas); assert.ok(absent.ok);
    assert.deepEqual(absent.value, { target: 'carol', rows: [], cursor: 0, oldest: 1, truncated: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('env.logs resumes from a cursor and keeps the newest rows within its named limits', async () => {
  const schemas = new Schemas(); await schemas.load();
  const { path, root } = await journal(Array.from({ length: 12 }, (_, index) => row('alice', `k${String(index)}`, { index })).join(''));
  try {
    const from = await targetLogs(path, 'alice', { from: 10 }, schemas); assert.ok(from.ok);
    assert.deepEqual(from.value.rows.map(entry => entry.cursor), [11, 12]);
    assert.equal(from.value.oldest, 11); assert.equal(from.value.truncated, false);
    const limited = await targetLogs(path, 'alice', { limit: 3 }, schemas); assert.ok(limited.ok);
    assert.deepEqual(limited.value.rows.map(entry => entry.cursor), [10, 11, 12]);
    assert.equal(limited.value.truncated, true, 'dropping older rows is reported');
    const capped = await targetLogs(path, 'alice', { limit: logLimits.rows * 10 }, schemas); assert.ok(capped.ok);
    assert.equal(capped.value.rows.length, 12);
    const beyond = await targetLogs(path, 'alice', { from: 99 }, schemas); assert.ok(beyond.ok);
    assert.deepEqual(beyond.value.rows, []); assert.equal(beyond.value.oldest, 13);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('env.logs bounds its reply by bytes and keeps the newest observations it can carry', async () => {
  const schemas = new Schemas(); await schemas.load();
  const wide = 'x'.repeat(50000); const kinds = ['a', 'b', 'c', 'd', 'e', 'f'];
  const { path, root } = await journal(kinds.map(kind => row('alice', kind, { wide })).join(''));
  try {
    const answer = await targetLogs(path, 'alice', {}, schemas); assert.ok(answer.ok);
    assert.ok(answer.value.rows.length < kinds.length, 'the byte bound dropped nothing');
    assert.ok(answer.value.rows.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry)), 0) <= logLimits.bytes);
    assert.equal(answer.value.truncated, true); assert.equal(answer.value.cursor, kinds.length);
    assert.equal(answer.value.rows.at(-1)?.kind, 'f', 'the newest observation survives');
    assert.equal(answer.value.oldest, answer.value.rows[0]?.cursor);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('env.logs refuses an unusable window, an unreadable journal and a row that is not an observation', async () => {
  const schemas = new Schemas(); await schemas.load();
  const { path, root } = await journal(row('alice', 'process.start', { pid: 1 }));
  try {
    for (const params of [{ from: -1 }, { from: 1.5 }, { from: 'first' }, { limit: -2 }, { limit: 'all' }, { limit: 0 }]) {
      const refused = await targetLogs(path, 'alice', params, schemas);
      assert.ok(!refused.ok, JSON.stringify(params)); assert.equal(refused.error.code, 'invalid-args');
    }
    const missing = await targetLogs(join(root, 'absent.jsonl'), 'alice', {}, schemas);
    assert.ok(!missing.ok); assert.equal(missing.error.code, 'io');
    await writeFile(path, `${JSON.stringify({ provenance: 'kernel-observed', target: 'alice', kind: 'process.start' })}\n`);
    const invalid = await targetLogs(path, 'alice', {}, schemas);
    assert.ok(!invalid.ok); assert.equal(invalid.error.code, 'invalid-args');
    await writeFile(path, 'not json\n');
    const broken = await targetLogs(path, 'alice', {}, schemas);
    assert.ok(!broken.ok); assert.equal(broken.error.code, 'invalid-args');
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('env.logs refuses an observation larger than the scan frame rather than reading it whole', async () => {
  const schemas = new Schemas(); await schemas.load();
  const { path, root } = await journal(row('alice', 'wide', { wide: 'x'.repeat(fileLimits.frameBytes) }));
  try {
    const refused = await targetLogs(path, 'alice', {}, schemas);
    assert.ok(!refused.ok); assert.equal(refused.error.code, 'frame-too-large');
  } finally { await rm(root, { recursive: true, force: true }); }
});
