/** Build typed real-process inputs for own-origin and interrupted-default tests; GN-005, KS-015. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { administrator, reviewer, evidence } from '@/test/default-act.ts';
import { snapshot } from '@/lib/snapshots/index.ts';
import { connect, socketFrames, send } from '@/lib/ndjson/socket.ts';
import { isObject } from '@/lib/schema/index.ts';

import { releaseDigest } from '@/lib/deployment/release.ts';
import type { Target, Mount } from '@/lib/deployment/types.ts';
export async function authority(path: string, method: string, params: Record<string, unknown>) {
  const socket = await connect(path); assert.ok(socket.ok);
  try {
    assert.ok((await send(socket.value, { method, params })).ok); const frame = await socketFrames(socket.value).next();
    assert.ok(!frame.done && frame.value.ok && isObject(frame.value.value)); return frame.value.value;
  } finally { socket.value.destroy(); }
}
export async function trustedFixture(interrupted = false) {
  const root = await mkdtemp('/tmp/trusted-kernel-'); const state = join(root, 'initial'); await mkdir(state); const work = join(root, 'work'); await mkdir(work);
  const repository = new URL('..', import.meta.url).pathname.replace(/\/$/u, ''); const source = join(repository, 'test/fixtures'); const hash = await snapshot(source); assert.ok(hash.ok);
  const target: Target = { id: 'authority', owner: '', scope: 'deployment', state, profile: {}, entries: [], services: [], revision: {
    plan: { name: 'fixture', version: '1.0.0', entry: join(source, 'evidence-process.ts'), args: [], cwd: '/state' }, pins: { fixture: { source, hash: hash.value, mount: source } },
    mounts: [...['lib', 'contracts', 'node_modules'].map((name): Mount => ({ source: join(repository, name), path: join(repository, name), mode: 'ro' })), { source: work, path: '/work', mode: 'rw', maximumBytes: 67108864 }], stateMount: '/state', endpointMount: '/endpoint', socketName: 'service.sock', quotaBytes: 67108864, formats: [], migrations: [], migrate: 'stop'
  } };
  const targets = interrupted ? [target, { ...target, id: 'secondary' }] : [target];
  const candidates = targets.map((target, index) => ({ ...target, profile: { release: 'reviewed', holdServing: interrupted && index === 1 } })); const digest = releaseDigest(candidates); const material = evidence(digest);
  const path = join(root, 'configuration.json'); const origin = join(root, 'origin.sock');
  await writeFile(path, JSON.stringify({ version: 1, root, cgroup: '/cgroup', identity: { people: [administrator, { ...reviewer, id: 'reviewer-user' }], bindings: [{ kind: 'password', id: 'external-reviewer', person: administrator.id }], authorities: { password: target.id } }, targets, trusted: {
    origin: 'https://kernel.test', socket: origin, keyFd: 3, administrator: administrator.id, baseline: 1, digest: releaseDigest(targets), releases: [{ digest, targets: candidates }], plans: [{ source: target.id, plan: material.plan }]
  } }));
  return { root, path, origin, digest, material, target, work, endpoint: (id = target.id) => join(root, 'targets', createHash('sha256').update(id).digest('base64url'), 'runs/public/current.sock') };
}
