/** Exercise promotion authority with the actual generation table and deterministic evidence; KS-014–016. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Act } from '../kernel/generations/act.ts';
import { Journal } from '../kernel/log/index.ts';
import { Generations } from '../kernel/generations/index.ts';
import { Schemas } from '../lib/schema/index.ts';
import { gate } from '../lib/evaluation/index.ts';
import type { Plan, Row } from '../lib/evaluation/index.ts';
import { forward, initial } from './generation-driver.ts';
import type { Principal, Run } from '../kernel/identity/index.ts';

export const reviewer: Principal = { id: 'reviewer', role: 'reviewer', projects: [], observeOthers: false };
export const administrator: Principal = { ...reviewer, role: 'admin' };
export const source: Run = { id: 'designated:1', person: '', scope: 'deployment', target: 'designated', generation: 1, services: [], expires: 1000 };
export function evidence(candidate: string, baseline = '1', pass = true) {
  const identities = { baseline, candidate, suite: 'suite', scorer: 'scorer', provider: 'instance', model: 'scripted', seed: 'seed-identity' };
  const plan: Plan = { identities, tasks: ['task'], regressions: [], runs: 3, scorers: ['scorer'], margin: -2 };
  const rows: Row[] = [];
  for (let run = 0; run < 3; run++) for (const arm of ['default', 'candidate'] satisfies Row['arm'][]) rows.push({ task: 'task', run, arm, scorer: 'scorer', kind: 'task', pass: arm === 'default' || pass, iterations: 1, cost: 0.001, counters: {}, dropped: 0, end: { reason: 'answer' } });
  return { plan, submission: { identities, rows } };
}

export async function actFixture() {
  const root = await mkdtemp('/tmp/default-act-'); const journal = await Journal.open(join(root, 'observed.jsonl'), () => 0); assert.ok(journal.ok);
  const schemas = new Schemas(); await schemas.load();
  const machine = new Generations('default', initial, journal.value, () => 0); let now = 0;
  const act = new Act({ root, journal: journal.value, schemas, now: () => now, baseline: () => machine.view.current.n,
    evaluate: (submission, plan) => Promise.resolve(gate(submission, plan)),
    async commit(digest, baseline) {
      for (const step of forward) {
        const result = await machine.transition(step.event === 'switch' ? { ...step, baseline, candidate: { ...initial, pins: { release: digest } } } : step);
        if (!result.ok) return result;
      }
      return { ok: true, value: undefined };
    }
  });
  return { act, machine, root, advance(milliseconds: number) { now += milliseconds; }, rows: () => readFile(join(root, 'observed.jsonl'), 'utf8'), async close() { await journal.value.close(); await rm(root, { recursive: true, force: true }); } };
}
