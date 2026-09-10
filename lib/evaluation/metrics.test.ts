/** Refuse incomplete paired evidence and derive the gate only from recorded outcomes; ADR 0014 §3. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gate, summarize, validators, calculate } from './index.ts';
import type { Plan, Row, Submission } from './index.ts';
import { Schemas } from '../schema/index.ts';
const plan: Plan = { identities: { baseline: '1', candidate: 'candidate', suite: 'suite', scorer: 'scorer', provider: 'provider', model: 'model', seed: 'seed' }, tasks: ['a', 'b'], regressions: ['r'], runs: 3, scorers: ['scorer'], margin: -2 };
function submission(): Submission {
  const rows: Row[] = [];
  for (const task of [...plan.tasks, ...plan.regressions]) for (let run = 0; run < plan.runs; run++) for (const arm of ['default', 'candidate']) {
    if (arm !== 'default' && arm !== 'candidate') throw new Error('Invalid fixture arm.');
    rows.push({ task, run, arm, scorer: 'scorer', kind: task === 'r' ? 'regression' : 'task', pass: true, iterations: 1, cost: 0.1, counters: { cost: 0.1 }, dropped: 0, end: { reason: 'answer' } });
  }
  return { identities: plan.identities, rows };
}
await test('ADR-0014 paired task bootstrap is deterministic and the strict margin controls the gate', async () => {
  const evidence = submission(); const first = gate(evidence, plan); const second = gate(evidence, plan);
  assert.ok(first.ok); assert.deepEqual(first, second); assert.deepEqual(first, await calculate(evidence, plan));
  assert.deepEqual(first.value.summary.suite_lift, { mean: 0, lower: 0, upper: 0 }); assert.equal(first.value.passed, true); assert.equal(first.value.summary.improved, false);
  const exact = gate(evidence, { ...plan, margin: 0 }); assert.ok(exact.ok); assert.equal(exact.value.passed, false);
  for (const row of evidence.rows) if (row.arm === 'candidate' && row.kind === 'task') row.pass = false;
  const lost = gate(evidence, plan); assert.ok(lost.ok); assert.equal(lost.value.summary.suite_lift.lower, -100); assert.equal(lost.value.passed, false); assert.equal(lost.value.summary.suite_cost.candidate, null);
});
await test('ADR-0014 missing, duplicate and unplanned evidence cannot make a gate', () => {
  const evidence = submission(); const row = evidence.rows[0]; assert.ok(row);
  assert.equal(gate({ ...evidence, rows: evidence.rows.slice(1) }, plan).ok, false);
  assert.equal(gate({ ...evidence, rows: [...evidence.rows, row] }, plan).ok, false);
  assert.equal(gate({ ...evidence, rows: [{ ...row, task: 'other' }, ...evidence.rows.slice(1)] }, plan).ok, false);
  const regression = evidence.rows.find(item => item.kind === 'regression' && item.arm === 'candidate'); assert.ok(regression); regression.pass = false;
  const result = gate(evidence, plan); assert.ok(result.ok); assert.equal(result.value.passed, false); assert.equal(result.value.summary.regressions, 1);
});
await test('ADR-0006 evaluation schemas tolerate unknown fields and reject nonfinite counters', () => {
  const checks = validators(new Schemas()); assert.ok(checks.plan(plan)); const evidence = submission();
  assert.ok(checks.submission({ ...evidence, future: true }));
  const first = evidence.rows[0]; assert.ok(first); first.counters['bad'] = Infinity;
  assert.equal(checks.submission(evidence), false);
  assert.equal(summarize(submission(), plan).ok, true);
});
