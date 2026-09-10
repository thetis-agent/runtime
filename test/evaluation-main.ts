/** Boot the production configuration path with private checks and ordinary-account candidate generations; EV-002, EV-006. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { executionFixture } from '@/test/execution-fixture.ts';
import { revision } from '@/test/runtime-fixture.ts';
import { discover } from '@/lib/package-loader/index.ts';
import { packagesRoot } from '@/lib/profile/packages-root.ts';
import { snapshot } from '@/lib/snapshots/index.ts';
import { seedIdentity } from '@/lib/evaluation/index.ts';
import { releaseDigest } from '@/lib/deployment/release.ts';
import { Secrets } from '@/kernel/secrets/index.ts';
import { administrator } from '@/test/default-act.ts';
import { kernelProcess } from '@/test/kernel-process.ts';

export async function evaluationMain() {
  const fixture = await executionFixture(); const root = await mkdtemp('/tmp/em-'); const state = join(root, 'initial'); await mkdir(state);
  const config = structuredClone(fixture.config); const seed = 'production-fixture-seed'; config.startup.plan.identities.seed = seedIdentity(seed);
  const candidate = config.startup.plan.identities.candidate; const arm = config.arms[candidate]; assert.ok(arm?.setup.runtime);
  const providerMount = arm.plan.mounts.find(mount => mount.path === '/services/provider.sock'); assert.ok(providerMount); providerMount.source = 'service:shared'; providerMount.path = '/services/provider'; arm.setup.runtime.providerSocket = '/services/provider/current.sock';
  const task = config.fixtures['task']; assert.ok(task); const check = task.checks['reviewed']; assert.ok(check);
  await writeFile(check.path, 'test "$(cat /space/answer.txt)" = "Hello Mira" && ! touch /space/no-write 2>/dev/null\n');
  const hash = await snapshot(join(fixture.root, 'private/checks')); assert.ok(hash.ok); check.hash = hash.value;
  const baseline = config.startup.releases[candidate]; assert.ok(baseline); config.startup.releases['1'] = baseline;
  const entries = await discover(packagesRoot(), '/state/packages', {}, fixture.schemas); assert.ok(entries.ok);
  const provider = { id: 'shared', owner: '', scope: 'deployment', state, profile: { rule: { name: 'cost', cost: 1, requests: 100, windowMs: 86400000 }, settings: { scripts: Array.from({ length: 6 }, () => [
    [{ type: 'delta.tool_call', callId: 'write', name: 'write_path', args: '{"path":"/space/answer.txt","contents":"Hello Mira"}' }, { type: 'stop', reason: 'tool_calls' }], [{ type: 'delta.text', text: 'Done.' }]
  ]).flat() } }, entries: [], services: [], revision: await revision('provider-mock', 'service.ts') };
  const plan = await revision('evaluator', 'service.ts');
  const evaluator = { id: config.source, owner: '', scope: 'deployment', state, profile: config.startup, entries: entries.value.filter(entry => entry.manifest.name === 'evaluator'), services: [], revision: plan,
    registration: { package: 'evaluator', id: 'runner', requires: {}, declared: { id: 'runner', cmd: 'node', args: [plan.plan.entry], env: { EVALUATOR_SEED: 'secret/evaluator.seed' }, health: { rpc: 'health.probe' }, restart: 'on-failure', scope: 'deployment', network: 'none' } } };
  const targets = [provider, evaluator]; const candidates = structuredClone(targets); const digest = releaseDigest(candidates); config.startup.plan.identities.candidate = digest;
  const release = config.startup.releases[candidate]; assert.ok(release); config.startup.releases = { '1': baseline, [digest]: release };
  const path = join(root, 'configuration.json'); const origin = join(root, 'origin.sock');
  await writeFile(path, JSON.stringify({ version: 1, root, cgroup: '/cgroup', identity: { people: [administrator, { id: 'alice', role: 'user', projects: [], observeOthers: false }], authorities: {}, bindings: [] }, targets, trusted: {
    origin: 'https://kernel.test', socket: origin, keyFd: 3, administrator: administrator.id, baseline: 1, digest: releaseDigest(targets), releases: [{ digest, targets: candidates }], plans: [{ source: config.source, plan: config.startup.plan }],
    execution: [{ ...config, account: 'alice', services: ['shared'], arms: { '1': arm, [digest]: arm } }]
  } }));
  const secrets = await Secrets.open(join(root, 'sealed'), Buffer.alloc(32, 7)); assert.ok(secrets.ok);
  assert.ok((await secrets.value.set(administrator, 'kernel', { scope: 'deployment', name: 'evaluator.seed', value: seed })).ok);
  assert.ok((await fixture.stopProvider()).ok);
  const kernel = await kernelProcess(path);
  return { root, kernel, source: config.source, candidate: digest, async close() { await kernel.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); } };
}
