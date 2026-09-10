/** Assemble ordinary identity, reviewed usage and real isolated loop/scorer processes; EV-002, EV-006. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Process } from '../kernel/boundary/process.ts';
import { Journal } from '../kernel/log/index.ts';
import type { Operation } from '../kernel/socket/index.ts';
import type { Method } from '../contracts/kernel-socket/types.ts';
import { Schemas } from '../lib/schema/index.ts';
import { failure } from '../lib/result/index.ts';
import { ManualClock } from '../lib/events/index.ts';
import { SandboxRunner } from '../lib/sandbox-runner/index.ts';
import { socketPair } from '../lib/socket/pair.ts';
import { discover } from '../lib/package-loader/index.ts';
import { packagesRoot } from '../lib/profile/packages-root.ts';
import { packageEntry, packageMounts } from './package-mounts.ts';
import { snapshot } from '../lib/snapshots/index.ts';
import { ExecutionRuntime } from '../lib/evaluation/runtime.ts';
import type { ExecutionHost, ExecutionConfiguration, Arm } from '../lib/evaluation/runtime.ts';
import { evaluationHost } from '../lib/deployment/evaluation.ts';
import { serviceFixture } from './provider-service.ts';
import type { Startup } from '../contracts/evaluator/types.ts';
const repository = new URL('..', import.meta.url).pathname.replace(/\/$/u, '');

async function arm(shared: Awaited<ReturnType<typeof serviceFixture>>, schemas: Schemas): Promise<Arm> {
  const entries = await discover(packagesRoot(repository), '/state/packages', {}, schemas); assert.ok(entries.ok);
  const selected = entries.value.filter(entry => ['core', 'tools-files'].includes(entry.manifest.name)); const pins: Record<string, { source: string; hash: string }> = {};
  for (const name of ['core', 'tools-files']) { const source = join(packagesRoot(repository), name); const hash = await snapshot(source); assert.ok(hash.ok); pins[name] = { source, hash: hash.value }; }
  return { pins, plan: { name: 'environment', version: '1.0.0', entry: packageEntry(repository, 'core', 'main.ts'), args: [], cwd: '/state', mounts: [
    ...packageMounts(repository, ['core', 'tools-files']), { source: join(shared.root, 'endpoint/service.sock'), path: '/services/provider.sock', mode: 'ro' }
  ] }, setup: { entries: selected, profile: {}, provided: {}, spaces: [], excluded: [], runtime: { root: '/state/conversations', providerSocket: '/services/provider.sock', person: 'alice', token: 'inherited', model: 'scripted', provider: 'shared', space: '/space', system: [], roots: [{ path: '/space', mode: 'rw', space: 'person' }], mode: { readOnly: false, deny: [] } } } };
}

async function host(root: string, shared: Awaited<ReturnType<typeof serviceFixture>>, schemas: Schemas): Promise<{ host: ExecutionHost; close(): Promise<void> }> {
  const journal = await Journal.open(join(root, 'journal.jsonl'), () => 0); assert.ok(journal.ok); const clock = new ManualClock(); const runner = new SandboxRunner('/cgroup');
  const principal = shared.identity.assert('password-authority', 'password', 'account-a'); assert.ok(principal.ok);
  return { host: evaluationHost({ root: join(root, 'execution'), journal: join(shared.root, 'rows.jsonl'), schemas, runner, clock, observe: (kind, value) => journal.value.observed('execution', kind, value),
    async authority() {
      const pair = await socketPair(); if (!pair.ok) return pair;
      const token = shared.identity.issue({ id: randomUUID(), person: '', scope: 'deployment', target: randomUUID(), generation: 1, services: [] }); if (!token.ok) { await pair.value.close(); return token; }
      return { ok: true, value: { socket: pair.value.client, token: token.value, close() { shared.identity.revoke(token.value); return pair.value.close(); } } };
    },
    async start(plan, setup, policy) {
      const target = randomUUID(); const token = shared.identity.issue({ id: target, person: principal.value.id, scope: 'person', target, generation: 1, services: ['shared'], cost: policy.cost }); if (!token.ok) return token;
      let diagnostic: unknown; const methods = new Map<Method, Operation>([['health.probe', () => Promise.resolve({ ok: true, value: { ready: true } })], ['profile.get', () => Promise.resolve({ ok: true, value: setup })],
        ...(['session.list', 'session.create', 'session.submit', 'session.cancel'] satisfies Method[]).map((method): [Method, Operation] => [method, () => Promise.resolve(failure('forbidden', 'A candidate cannot route its own upstream request.'))])]);
      const started = await Process.start(plan, token.value, { target, identity: shared.identity, schemas, clock, runner, journal: journal.value, operations: { methods, notes: ['run.stop', 'env.updated', 'turn.report', 'notice'], note: (run, note) => {
        if (note.note === 'turn.report') diagnostic = note.params;
        return journal.value.reported(run.target, note.note, note.params);
      } } });
      if (!started.ok) return started;
      return { ok: true, value: { process: started.value, target, diagnostic: () => diagnostic } };
    }
  }), close: () => journal.value.close() };
}

export async function executionFixture() {
  const shared = await serviceFixture(1, { scripts: [[{ type: 'delta.tool_call', callId: 'write', name: 'write_path', args: '{"path":"/space/answer.txt","contents":"Hello Mira"}' }, { type: 'stop', reason: 'tool_calls' }], [{ type: 'delta.text', text: 'Finished.' }]] }, 'deployment', { people: [{ id: 'alice', role: 'user', projects: [], observeOthers: false }], authorities: { password: 'password-authority' }, bindings: [{ kind: 'password', id: 'account-a', person: 'alice' }] });
  assert.ok((await shared.process.probe()).ok); const root = await mkdtemp('/tmp/execution-fixture-'); const privateRoot = join(root, 'private'); const source = join(privateRoot, 'fixture'); const checks = join(privateRoot, 'checks');
  await mkdir(source, { recursive: true }); await mkdir(checks); await writeFile(join(source, 'Alice.txt'), 'Alice has 12 files.');
  await writeFile(join(checks, 'run.sh'), 'test "$(cat /space/Mira.txt)" = "Mira has 99 files." && test "$(cat /space/answer.txt)" = "Hello Mira" && ! touch /space/no-write 2>/dev/null\n');
  const stateHash = await snapshot(source); const checkHash = await snapshot(checks); assert.ok(stateHash.ok && checkHash.ok);
  const schemas = new Schemas(); await schemas.load(); const selected = await arm(shared, schemas); const release = `sha256:${'a'.repeat(64)}`;
  const startup: Startup = { plan: { identities: { baseline: '1', candidate: release, suite: 'private', scorer: 'reviewed', provider: 'shared', model: 'scripted', seed: 'secret-id' }, tasks: ['task'], regressions: [], runs: 3, scorers: ['reviewed'], margin: -2 },
    cases: [{ kind: 'task', task: { id: 'task', family: 'tool', request: 'Read Alice.txt.', mutable: { names: ['Alice'], numbers: ['12'] }, requires: [], required: [], gold: { tools: [], skills: [] }, budget: { cost: 1, iterations: 8 }, fixture: source, checks: join(checks, 'run.sh') } }], releases: { [release]: { name: 'environment', version: '1.0.0', hash: release } }, stoplist: [], coreChanged: false };
  const config: ExecutionConfiguration = { source: 'evaluator', startup, arms: { [release]: selected }, fixtures: { task: { source, hash: stateHash.value, checks: { reviewed: { path: join(checks, 'run.sh'), hash: checkHash.value } } } }, privateRoots: [privateRoot] };
  const bridge = await host(root, shared, schemas); const runtime = new ExecutionRuntime(bridge.host, config);
  return { runtime, config, root, schemas, release, stopProvider: () => shared.process.stop('fixture preparation complete'),
    async close() { const closed = await runtime.close(); assert.ok(closed.ok); await bridge.close(); await shared.close(); await rm(root, { recursive: true, force: true }); } };
}
