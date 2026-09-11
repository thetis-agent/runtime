/** Run real verified candidate code against a private fixture and an isolated scorer; EV-002, EV-006. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { executionFixture } from '@/test/execution-fixture.ts';
import type { RunRequest } from '@/contracts/evaluator/types.ts';
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

/* EV-001. The three operations differ in exactly three ways — which validator, which handler, which
 * words a malformed request is refused with — and agree about everything else, including the order.
 *
 * The ordering is the part worth a test rather than a reading. Authorization runs before validation,
 * so a caller that is not the configured source is refused without its parameters ever being read;
 * were that the other way round, a wrong source could map the shape of a well-formed request by
 * sending malformed ones and watching which refusal came back. */
await test('EV-001 every evaluation operation authorizes before it validates, and refuses each in its own words', async () => {
  const f = await executionFixture();
  try {
    const operations = f.runtime.operations(f.schemas);
    const authorized = { target: f.config.source, scope: 'deployment' };
    const wrongScope = { target: f.config.source, scope: 'person' };
    const wrongSource = { target: 'somebody-else', scope: 'deployment' };
    const malformed = { operation: 'nonsense' };

    for (const [method, subject] of [['install', 'run'], ['snapshot', 'score'], ['prune', 'release']] as const) {
      const operation = operations.get(method); assert.ok(operation, `${method} is not offered.`);
      // The right target in the wrong scope, and the right scope from the wrong target, are both
      // refused — and refused identically, whatever the parameters were.
      for (const source of [wrongScope, wrongSource]) {
        const refused = await operation(source, malformed);
        assert.ok(!refused.ok, `${method} admitted ${source.scope}/${source.target}.`);
        assert.equal(refused.error.code, 'forbidden');
        assert.match(refused.error.message, /not authorized for private evaluation/u,
          `${method} told an unauthorized caller its parameters were malformed.`);
      }
      // Authorized and malformed: the refusal names this method's own request rather than another's,
      // which is the whole reason the message is an argument instead of a constant in the adapter.
      const invalid = await operation(authorized, malformed);
      assert.ok(!invalid.ok); assert.equal(invalid.error.code, 'invalid-args');
      assert.equal(invalid.error.message, `The evaluation ${subject} request violates its schema.`);
    }

    /* A well-formed request reaches its handler: `prune` proves both halves at once — that the
     * adapter projects `request.id` for a handler that takes an id rather than a request, and that a
     * field the contract does not name survives validation instead of being stripped on the way in.
     * `not-found` is the handler's own answer, so the call got that far. */
    const prune = operations.get('prune'); assert.ok(prune);
    const missing = await prune(authorized, { operation: 'evaluation.release', id: 'no-such-snapshot', unknown: true });
    assert.ok(!missing.ok); assert.equal(missing.error.code, 'not-found');
  } finally { await f.close(); }
});
