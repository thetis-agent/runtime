/** Preserve lazy evaluation authority and first-use ownership through real candidate generations; EV-002, EV-006. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { evaluationBootstrap } from '@/lib/deployment/evaluation-bootstrap.ts';
import type { Evaluation } from '@/lib/deployment/evaluation-bootstrap.ts';
import type { Execution } from '@/lib/deployment/types.ts';
import type { Method } from '@/contracts/kernel-socket/types.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import { SandboxRunner } from '@/lib/sandbox-runner/index.ts';
import { runtimeFixture } from '@/test/runtime-fixture.ts';
import { executionFixture } from '@/test/execution-fixture.ts';

type ExecutionFixture = Awaited<ReturnType<typeof executionFixture>>;

function configured(material: ExecutionFixture, source: string, account: string): Execution {
  const config = structuredClone(material.config);
  const arms: Execution['arms'] = {};
  for (const [id, arm] of Object.entries(config.arms)) {
    const setup = arm.setup.runtime; assert.ok(setup);
    setup.person = account; setup.providerSocket = '/services/provider/current.sock';
    const provider = arm.plan.mounts.find(mount => mount.path === '/services/provider.sock'); assert.ok(provider);
    provider.source = 'service:shared'; provider.path = '/services/provider';
    arms[id] = { ...arm, plan: { ...arm.plan, args: [...arm.plan.args], mounts: arm.plan.mounts.map(mount => ({ ...mount })) } };
  }
  const fixtures = Object.fromEntries(Object.entries(config.fixtures).map(([id, fixture]) => [id, { ...fixture }]));
  return { ...config, arms, fixtures, privateRoots: [...config.privateRoots], source, account, services: ['shared'] };
}

async function fixture() {
  const runtime = await runtimeFixture();
  let material: ExecutionFixture;
  try { material = await executionFixture(); }
  catch (error) { await runtime.close(); throw error; }
  const state: { available: boolean; resolutions: string[]; launches: { account: string; services: readonly string[] }[] } = {
    available: false, resolutions: [], launches: []
  };
  const started = Promise.withResolvers<undefined>(); const release = Promise.withResolvers<undefined>();
  let hold = false;
  const context: Parameters<typeof evaluationBootstrap>[0] = {
    root: join(runtime.root, 'execution'), journal: join(runtime.root, 'observed.jsonl'),
    schemas: runtime.schemas, clock: runtime.clock, runner: new SandboxRunner('/cgroup'),
    endpoint(id) {
      state.resolutions.push(id);
      return state.available ? runtime.runtime.endpointDirectory(id) : failure('not-found', 'The evaluation service is not ready.');
    },
    async start(account, services, ...args) {
      state.launches.push({ account, services });
      if (hold) { hold = false; started.resolve(undefined); await release.promise; }
      return runtime.runtime.transient(account, services, ...args);
    },
    authority: () => runtime.runtime.emptyAuthority(),
    observe: (kind, data) => runtime.journal.observed('execution', kind, data)
  };
  try {
    const inputs = [configured(material, 'first', 'alice'), configured(material, 'second', 'bob')];
    const prepared = await evaluationBootstrap(context, {
      execution: inputs,
      plans: inputs.map(input => ({ source: input.source, plan: input.startup.plan }))
    });
    assert.ok(prepared.ok, JSON.stringify(prepared));
    return {
      evaluation: prepared.value, state, material, runtime, context, inputs,
      holdNextLaunch() { hold = true; return { started: started.promise, release: () => { release.resolve(undefined); } }; },
      snapshot(source: string, id: string) { return join(context.root, createHash('sha256').update(source).digest('base64url'), id); },
      async close() {
        release.resolve(undefined);
        try { assert.ok((await prepared.value.close()).ok); }
        finally { await runtime.close(); await material.close(); }
      }
    };
  } catch (error) { await runtime.close(); await material.close(); throw error; }
}

function operation(evaluation: Evaluation, source: string, method: Method) {
  const operation = evaluation.extension(source).methods.get(method); assert.ok(operation);
  return operation;
}

async function installed(evaluation: Evaluation, material: ExecutionFixture, source: string): Promise<string> {
  const result = await operation(evaluation, source, 'install')({ target: source, scope: 'deployment' }, {
    name: 'environment', version: '1.0.0', hash: material.release, operation: 'evaluation.run', pins: material.release,
    task: 'task', input: { text: 'Read Alice.txt.', attachments: [] }, fixture: 'ignored-untrusted-path', mutation: {},
    provider: 'shared', model: 'scripted', modelSeed: 42, budget: { cost: 0, iterations: 1 }, withheld: { tools: [], skills: [] }
  });
  assert.ok(result.ok, JSON.stringify(result)); assert.ok(isObject(result.value));
  const id = result.value['snapshot']; assert.ok(typeof id === 'string');
  return id;
}

await test('EV-006 lazy evaluation refuses foreign runs, retries unavailable services and reuses each approved source', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.evaluation.extension('unknown').capabilities, []);
    assert.equal(f.evaluation.extension('unknown').methods.size, 0);
    const prune = operation(f.evaluation, 'first', 'prune');
    assert.deepEqual(f.state.resolutions, []);
    for (const run of [{ target: 'second', scope: 'deployment' }, { target: 'first', scope: 'person' }]) {
      const denied = await prune(run, { operation: 'evaluation.release', id: 'absent' });
      assert.ok(!denied.ok); assert.equal(denied.error.code, 'forbidden');
    }
    assert.deepEqual(f.state.resolutions, []);
    const unavailable = await prune({ target: 'first', scope: 'deployment' }, { operation: 'evaluation.release', id: 'absent' });
    assert.deepEqual(unavailable, failure('not-found', 'The evaluation service is not ready.'));
    assert.deepEqual(f.state.resolutions, ['shared']);
    assert.ok((await f.evaluation.close()).ok); assert.deepEqual(f.state.resolutions, ['shared']);
    f.state.available = true;
    const retried = await prune({ target: 'first', scope: 'deployment' }, { operation: 'evaluation.release', id: 'absent' });
    assert.deepEqual(retried, failure('not-found', 'The evaluation snapshot does not exist.'));
    assert.deepEqual(f.state.resolutions, ['shared', 'shared']);
    f.state.available = false;
    const invalid = await operation(f.evaluation, 'first', 'install')({ target: 'first', scope: 'deployment' }, {});
    assert.ok(!invalid.ok); assert.equal(invalid.error.code, 'invalid-args');
    const repeated = await operation(f.evaluation, 'first', 'prune')({ target: 'first', scope: 'deployment' }, { operation: 'evaluation.release', id: 'absent' });
    assert.deepEqual(repeated, retried); assert.deepEqual(f.state.resolutions, ['shared', 'shared']);
    const separate = await operation(f.evaluation, 'second', 'prune')({ target: 'second', scope: 'deployment' }, { operation: 'evaluation.release', id: 'absent' });
    assert.deepEqual(separate, unavailable); assert.deepEqual(f.state.resolutions, ['shared', 'shared', 'shared']);
    assert.deepEqual(f.state.launches, []);
  } finally { await f.close(); }
});

await test('EV-006 lazy evaluation isolates snapshots and closes owned runtimes in first-use order', async () => {
  const f = await fixture();
  let held: ReturnType<typeof f.holdNextLaunch> | undefined;
  let pending: Promise<string> | undefined;
  try {
    f.state.available = true;
    const second = await installed(f.evaluation, f.material, 'second');
    const first = await installed(f.evaluation, f.material, 'first');
    await access(f.snapshot('second', second)); await access(f.snapshot('first', first));
    assert.deepEqual(f.state.launches, [{ account: 'bob', services: ['shared'] }, { account: 'alice', services: ['shared'] }]);
    assert.deepEqual(f.state.resolutions, ['shared', 'shared']);
    const foreign = await operation(f.evaluation, 'first', 'prune')({ target: 'first', scope: 'deployment' }, { operation: 'evaluation.release', id: second });
    assert.deepEqual(foreign, failure('not-found', 'The evaluation snapshot does not exist.'));
    held = f.holdNextLaunch(); pending = installed(f.evaluation, f.material, 'first');
    await Promise.race([held.started, pending]);
    const busy = await f.evaluation.close(); assert.ok(!busy.ok); assert.equal(busy.error.code, 'switching');
    await assert.rejects(access(f.snapshot('second', second)), { code: 'ENOENT' });
    await access(f.snapshot('first', first));
    held.release(); const latest = await pending;
    assert.ok((await f.evaluation.close()).ok);
    await assert.rejects(access(f.snapshot('first', first)), { code: 'ENOENT' });
    await assert.rejects(access(f.snapshot('first', latest)), { code: 'ENOENT' });
    assert.deepEqual(f.state.resolutions, ['shared', 'shared']);
  } finally {
    held?.release();
    try { await pending; } finally { await f.close(); }
  }
});

await test('EV-006 lazy evaluation retains approved-plan and ordinary-account checks before resolving services', async () => {
  const f = await fixture();
  try {
    const [first] = f.inputs; assert.ok(first);
    const plans = [{ source: first.source, plan: first.startup.plan }];
    const changed = structuredClone(first); changed.startup.plan.identities.model = 'unapproved';
    for (const execution of [[changed], [first, first], [{ ...first, account: 'bob' }]]) {
      const result = await evaluationBootstrap(f.context, { execution, plans });
      assert.ok(!result.ok); assert.equal(result.error.code, 'forbidden');
    }
    assert.deepEqual(f.state.resolutions, []); assert.deepEqual(f.state.launches, []);
  } finally { await f.close(); }
});
