/** Drive the evaluator through a real loop and mandatory outcome sandbox; EV-001–004. */
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { loopFixture } from '@/test/loop-fixture.ts';
import type { Execution, TurnJob, CheckJob, Outcome } from '@/packages/evaluator/index.ts';
import { Scorer } from '@/lib/evaluation/scorer.ts';
import { SandboxRunner } from '@/lib/sandbox-runner/index.ts';
import { ManualClock } from '@/lib/events/index.ts';
import { socketPair } from '@/lib/socket/pair.ts';
import { Schemas } from '@/lib/schema/index.ts';
import type { End } from '@/contracts/turn-events/types.ts';
import type { Result } from '@/lib/result/index.ts';

export class EvaluationDriver implements Execution {
  readonly jobs: TurnJob[] = [];
  readonly checks: CheckJob[] = [];
  async turn(job: TurnJob): Promise<Result<Outcome>> {
    this.jobs.push(structuredClone(job)); const f = await loopFixture();
    const result = await f.loop.turn(job.input, f.options, new AbortController().signal);
    if (!result.ok) { await f.close(); return result; }
    const schemas = new Schemas(); await schemas.load();
    const end = f.events.findLast(event => event.type === 'end')?.payload;
    assert.ok(schemas.validator<End>('turn-events', 'end')(end));
    const counters: Record<string, number> = {};
    for (const report of f.provider.reports) for (const [name, value] of Object.entries(report.counters)) counters[name] = (counters[name] ?? 0) + value;
    return { ok: true, value: { snapshot: f.directory, iterations: end.iterations, cost: counters['cost'] ?? 0, counters, dropped: 0, end: { reason: end.reason } } };
  }
  async score(job: CheckJob): Promise<Result<{ pass: boolean }>> {
    this.checks.push(structuredClone(job));
    const pair = await socketPair(); assert.ok(pair.ok);
    try { return await new Scorer(new SandboxRunner('/cgroup'), new ManualClock()).run({ checks: job.checks, snapshot: job.snapshot, replacements: job.replacements, authority: { socket: pair.value.client, token: 'ordinary-fixture-token' } }); }
    finally { assert.ok((await pair.value.close()).ok); }
  }
  async release(snapshot: string): Promise<Result<void>> {
    await rm(snapshot, { recursive: true, force: true }); return { ok: true, value: undefined };
  }
}
