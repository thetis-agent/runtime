/** Compute paired evidence by task so repeated runs cannot inflate confidence; ADR 0014 §3. */
import { failure } from '@/lib/result/index.ts';
import type { Result } from '@/lib/result/index.ts';
import type { Plan, Row, Submission } from './types.ts';
import { random } from './random.ts';

export const metricLimits = { bootstrapSamples: 2000, rows: 8192, tasks: 256 };
export type { Interval, Summary, Gate } from './types.ts';
import type { Interval, Summary, Gate } from './types.ts';

function key(row: Row): string { return JSON.stringify([row.task, row.run, row.arm, row.scorer, row.kind]); }

function complete(rows: readonly Row[], plan: Plan): Result<void, 'invalid-args'> {
  if (rows.length > metricLimits.rows || plan.tasks.length > metricLimits.tasks || !plan.tasks.length) return failure('invalid-args', 'The evaluation exceeds its row or task limit.');
  const expected = new Set<string>();
  for (const [kind, tasks] of [['task', plan.tasks], ['regression', plan.regressions]]) {
    if (!Array.isArray(tasks)) throw new Error('The evaluation plan is malformed.');
    for (const task of tasks) for (let run = 0; run < plan.runs; run++) for (const scorer of plan.scorers) for (const arm of ['default', 'candidate']) expected.add(JSON.stringify([task, run, arm, scorer, kind]));
  }
  for (const row of rows) {
    if (row.ablation) continue;
    if (!expected.delete(key(row))) return failure('invalid-args', 'The evaluation contains a duplicate or unplanned row.');
  }
  return expected.size ? failure('invalid-args', 'The evaluation is missing a planned row.') : { ok: true, value: undefined };
}

export function bootstrap(values: readonly number[], seed: string, samples = metricLimits.bootstrapSamples): Interval {
  if (!values.length || values.length > metricLimits.tasks || !Number.isSafeInteger(samples) || samples < 100 || samples > 10000 || values.some(value => !Number.isFinite(value))) throw new Error('Invalid bootstrap inputs.');
  const draw = random(seed); const means: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    let total = 0;
    for (let item = 0; item < values.length; item++) total += values[Math.floor(draw() * values.length)] ?? 0;
    means.push(total / values.length);
  }
  means.sort((a, b) => a - b);
  const lower = means[Math.floor(samples * 0.025)]; const upper = means[Math.ceil(samples * 0.975) - 1];
  if (lower === undefined || upper === undefined) throw new Error('The bootstrap has no interval.');
  return { mean: values.reduce((sum, value) => sum + value, 0) / values.length, lower, upper };
}

function cost(rows: readonly Row[], arm: Row['arm']): number | null {
  const selected = rows.filter(row => row.arm === arm && row.kind === 'task' && !row.ablation);
  const passes = selected.filter(row => row.pass).length;
  return passes ? selected.reduce((total, row) => total + row.cost, 0) / passes : null;
}

export function summarize(submission: Submission, plan: Plan): Result<Summary, 'invalid-args'> {
  const valid = complete(submission.rows, plan); if (!valid.ok) return valid;
  const values = plan.tasks.map(task => submission.rows.filter(row => row.kind === 'task' && row.task === task && !row.ablation).reduce((delta, row) => delta + (row.pass ? (row.arm === 'candidate' ? 100 : -100) : 0), 0) / (plan.runs * plan.scorers.length));
  const suite_lift = bootstrap(values, `${plan.identities.seed}:bootstrap`);
  const regressions = new Set(submission.rows.filter(row => row.kind === 'regression' && row.arm === 'candidate' && !row.ablation && !row.pass).map(row => row.task)).size;
  return { ok: true, value: { suite_lift, suite_cost: { default: cost(submission.rows, 'default'), candidate: cost(submission.rows, 'candidate') }, regressions, improved: suite_lift.lower > 0 } };
}

export function gate(submission: Submission, plan: Plan): Result<Gate, 'invalid-args'> {
  const summary = summarize(submission, plan); if (!summary.ok) return summary;
  return { ok: true, value: { passed: summary.value.suite_lift.lower > plan.margin && summary.value.regressions === 0, margin: plan.margin, summary: summary.value } };
}
