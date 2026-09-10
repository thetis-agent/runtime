/** Expose the real kernel transport edge for malformed-frame acceptance tests; TE-031. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SandboxRunner } from '@/lib/sandbox-runner/index.ts';
import type { Mount } from '@/lib/sandbox-runner/index.ts';
import { socketPair } from '@/lib/socket/pair.ts';
import { accept } from '@/kernel/socket/index.ts';
import { Schemas } from '@/lib/schema/index.ts';
import { ManualClock } from '@/lib/events/index.ts';
import type { providerFixture } from '@/test/provider-fixture.ts';
import { packageEntry, packageMounts } from '@/test/package-mounts.ts';

export async function faultProcess(provider: ReturnType<typeof providerFixture>, providerPath: string) {
  const root = await mkdtemp('/tmp/frame-fault-'); await mkdir(join(root, 'state')); await mkdir(join(root, 'endpoint'));
  const schemas = new Schemas(); await schemas.load(); const clock = new ManualClock();
  const pair = await socketPair(); assert.ok(pair.ok);
  const repository = new URL('..', import.meta.url).pathname.replace(/\/$/u, '');
  const profile = { entries: [], profile: {}, provided: {}, spaces: [], excluded: [], runtime: {
    root: '/state/conversations', endpoint: '/endpoint/service.sock', providerSocket: '/services/provider.sock', person: 'person', token: provider.token,
    model: 'scripted', provider: 'instance', space: '/state', system: [], roots: [], mode: { readOnly: false, deny: [] }
  } };
  const accepting = accept(pair.value.peer, provider.token, provider.identity, schemas, clock, { capabilities: ['session.create', 'session.submit', 'health.probe'], methods: new Map([
    ['profile.get', () => Promise.resolve({ ok: true, value: profile })]
  ]), notes: ['turn.report', 'notice'], note: () => Promise.resolve({ ok: true, value: undefined }) });
  const started = await new SandboxRunner('/cgroup').start({ name: 'fixture', version: '1.0.0', entry: packageEntry(repository, 'core', 'main.ts'), args: [], cwd: '/state', socket: pair.value.client, token: provider.token, mounts: [
    ...packageMounts(repository, ['core']),
    ...['state', 'endpoint'].map((name): Mount => ({ source: join(root, name), path: `/${name}`, mode: 'rw', maximumBytes: 67108864 })),
    { source: providerPath, path: '/services/provider.sock', mode: 'ro' }
  ] }); assert.ok(started.ok); pair.value.client.destroy(); const connected = await accepting; assert.ok(connected.ok);
  return { root, peer: connected.value, raw: pair.value.peer, running: started.value, async close() {
    assert.ok((await started.value.stop()).ok); connected.value.close(); assert.ok((await pair.value.close()).ok); await rm(root, { recursive: true, force: true });
  } };
}
