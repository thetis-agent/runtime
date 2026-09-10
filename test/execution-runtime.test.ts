/** Run real verified candidate code against a private fixture and an isolated scorer; EV-002, EV-006. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { executionFixture } from './execution-fixture.ts';
import type { RunRequest } from '../contracts/evaluator/types.ts';
await test('EV-006 an ordinary bound account runs the actual seeded candidate and its frozen outcome is scored privately', async () => {
  const f = await executionFixture();
  try {
    const request: RunRequest = { name: 'environment', version: '1.0.0', hash: f.release, operation: 'evaluation.run', pins: f.release, task: 'task', input: { text: 'Read Mira.txt and finish.', attachments: [] }, fixture: 'ignored-untrusted-path', mutation: { Alice: 'Mira', '12': '99' }, provider: 'shared', model: 'scripted', modelSeed: 42, budget: { cost: 1, iterations: 8 }, withheld: { tools: [], skills: [] } };
    const installed = await f.runtime.run(request); assert.ok(installed.ok, JSON.stringify(installed));
    assert.equal(installed.value.end.reason, 'answer'); assert.equal(installed.value.iterations, 2); assert.ok(installed.value.cost > 0);
    const score = await f.runtime.score({ target: installed.value.snapshot, snapshot: installed.value.snapshot, operation: 'evaluation.score', scorer: 'reviewed', checks: '/untrusted/check.sh', replacements: { Alice: 'forged' } });
    assert.deepEqual(score, { ok: true, value: { pass: true } });
    assert.deepEqual(await f.runtime.score({ target: installed.value.snapshot, snapshot: installed.value.snapshot, operation: 'evaluation.score', scorer: 'reviewed', checks: '/ignored', replacements: {} }), score);
    const rows = await readFile(join(f.root, 'journal.jsonl'), 'utf8'); assert.match(rows, /"provenance":"kernel-observed".*"kind":"evaluation.outcome"/u);
    assert.match(rows, /"cached":true/u);
    assert.ok(!rows.includes('Hello Mira'));
    const outcomeFile = join(f.root, 'execution', installed.value.snapshot, 'answer.txt'); await chmod(outcomeFile, 0o600); await writeFile(outcomeFile, 'changed');
    const tampered = await f.runtime.score({ target: installed.value.snapshot, snapshot: installed.value.snapshot, operation: 'evaluation.score', scorer: 'reviewed', checks: '/ignored', replacements: {} });
    assert.ok(!tampered.ok); assert.equal(tampered.error.code, 'hash-mismatch');
    assert.ok((await f.runtime.release(installed.value.snapshot)).ok); assert.equal((await f.runtime.release(installed.value.snapshot)).ok, false);
    const denied = await f.runtime.operations(f.schemas).get('install')?.({ target: 'person', scope: 'person' }, request); assert.ok(denied && !denied.ok); assert.equal(denied.error.code, 'forbidden');
    const budgeted = await f.runtime.run({ ...request, budget: { cost: 0, iterations: 1 } }); assert.ok(budgeted.ok, JSON.stringify(budgeted));
    assert.equal(budgeted.value.cost, 0); assert.equal(budgeted.value.end.reason, 'crash');
    assert.equal((await f.runtime.run({ ...request, hash: `sha256:${'f'.repeat(64)}` })).ok, false);
  } finally { await f.close(); }
});
