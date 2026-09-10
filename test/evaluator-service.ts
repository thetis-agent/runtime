/** Exercise private evaluator delegation through a real registered process and trusted act; ADR 0014. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Identity } from '@/kernel/identity/index.ts';
import { Journal } from '@/kernel/log/index.ts';
import { Process } from '@/kernel/boundary/process.ts';
import type { Operation } from '@/kernel/socket/index.ts';
import type { Method } from '@/contracts/kernel-socket/types.ts';
import { Schemas } from '@/lib/schema/index.ts';
import { failure } from '@/lib/result/index.ts';
import { ManualClock } from '@/lib/events/index.ts';
import { SandboxRunner } from '@/lib/sandbox-runner/index.ts';
import { seedIdentity } from '@/lib/evaluation/index.ts';
import { packageEntry, packageMounts } from '@/test/package-mounts.ts';
import schema from '@/contracts/evaluator/schema.json' with { type: 'json' };
import type { Startup, RunRequest, ScoreRequest } from '@/contracts/evaluator/types.ts';
import { EvaluationDriver } from '@/test/evaluator-driver.ts';
import { actFixture, administrator } from '@/test/default-act.ts';

function operations(settings: Startup, schemas: Schemas, act: Awaited<ReturnType<typeof actFixture>>['act']) {
  schemas.compile(schema); const run = schemas.compile<RunRequest>({ $ref: `${schema.$id}#/$defs/runRequest` }); const score = schemas.compile<ScoreRequest>({ $ref: `${schema.$id}#/$defs/scoreRequest` });
  const driver = new EvaluationDriver(); const snapshots = new Set<string>();
  return new Map<Method, Operation>([
    ['health.probe', () => Promise.resolve({ ok: true, value: { ready: true } })], ['profile.get', () => Promise.resolve({ ok: true, value: settings })],
    ['install', async (_source, params) => {
      if (!run(params) || params.hash !== settings.releases[params.pins]?.hash) return failure('invalid-args', 'The evaluation arm is not verified.');
      const result = await driver.turn(params); if (result.ok) snapshots.add(result.value.snapshot); return result;
    }],
    ['snapshot', (_source, params) => {
      if (!score(params) || !snapshots.has(params.snapshot) || !settings.plan.scorers.includes(params.scorer)) return Promise.resolve(failure('forbidden', 'The scorer does not own this snapshot.'));
      const task = settings.cases[0]; assert.ok(task);
      return driver.score({ ...params, checks: task.task.checks });
    }],
    ['prune', async (_source, params) => {
      const id = params['id']; if (typeof id !== 'string' || !snapshots.delete(id)) return failure('forbidden', 'The snapshot is not owned by this evaluation.');
      return await driver.release(id);
    }], ['results.submit', (source, params) => act.submit(source, params)]
  ]);
}

export async function evaluatorService() {
  const root = await mkdtemp('/tmp/evaluator-service-'); await mkdir(join(root, 'endpoint')); const checks = join(root, 'run.sh'); await writeFile(checks, 'test -s /space/conversation.jsonl\n');
  const time = new ManualClock(); const schemas = new Schemas(); await schemas.load(); const hash = `sha256:${'a'.repeat(64)}`;
  const settings: Startup = { plan: { identities: { baseline: '1', candidate: hash, suite: 'private', scorer: 'reviewed', provider: 'instance', model: 'scripted', seed: seedIdentity('fixture-private-seed') }, tasks: ['private-task'], regressions: [], runs: 3, scorers: ['reviewed'], margin: -2 },
    cases: [{ kind: 'task', task: { id: 'private-task', family: 'tool', request: 'Say hello to Alice.', mutable: { names: ['Alice'] }, requires: [], required: [], gold: { tools: [], skills: [] }, budget: { cost: 1, iterations: 3 }, checks, fixture: root } }],
    releases: { '1': { name: 'candidate', version: '1.0.0', hash }, [hash]: { name: 'candidate', version: '1.0.0', hash } }, stoplist: [], coreChanged: false };
  const act = await actFixture(); assert.ok(act.act.authorize(administrator, 'evaluation', settings.plan).ok);
  const journal = await Journal.open(join(root, 'rows.jsonl'), () => 0); assert.ok(journal.ok);
  const identity = new Identity({ people: [], authorities: {}, bindings: [] }, () => 0); const token = identity.issue({ id: 'evaluation', person: '', scope: 'deployment', target: 'evaluation', generation: 1, services: [] }); assert.ok(token.ok);
  const repository = new URL('..', import.meta.url).pathname.replace(/\/$/u, '');
  const started = await Process.start({ name: 'fixture', version: '1.0.0', entry: packageEntry(repository, 'evaluator', 'service.ts'), args: [], cwd: '/tmp', secrets: { EVALUATOR_SEED: 'fixture-private-seed' }, mounts: [
    ...packageMounts(repository, ['evaluator']), { source: join(root, 'endpoint'), path: '/endpoint', mode: 'rw', maximumBytes: 67108864 }
  ] }, token.value, { target: 'evaluation', identity, schemas, clock: time, journal: journal.value, runner: new SandboxRunner('/cgroup'), operations: { methods: operations(settings, schemas, act.act), capabilities: ['install.run', 'snapshot.score'], notes: ['run.stop', 'env.updated'], note: () => Promise.resolve({ ok: true, value: undefined }) } }); assert.ok(started.ok);
  return { root, process: started.value, settings, act, async close() {
    assert.ok((await started.value.stop('test complete')).ok); await journal.value.close(); await act.close(); await rm(root, { recursive: true, force: true });
  } };
}
