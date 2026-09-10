/** Keep metrics queries sandboxed and authority in the kernel while returning only summary data; ADR 0017. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Identity } from '../kernel/identity/index.ts';
import { Journal } from '../kernel/log/index.ts';
import { Process } from '../kernel/boundary/process.ts';
import type { Method } from '../contracts/kernel-socket/types.ts';
import type { Operation } from '../kernel/socket/index.ts';
import { Schemas } from '../lib/schema/index.ts';
import { SandboxRunner } from '../lib/sandbox-runner/index.ts';
import { ManualClock } from '../lib/events/index.ts';
import { packageEntry, packageMounts } from './package-mounts.ts';
import { connect, send, socketFrames } from '../lib/ndjson/socket.ts';
import { isObject } from '../lib/result/index.ts';
import { evidence } from './default-act.ts';

await test('ADR-0017 registered metrics computes aggregate scores without accessing the trusted act', async () => {
  const root = await mkdtemp('/tmp/metrics-service-'); await mkdir(join(root, 'endpoint'));
  const schemas = new Schemas(); await schemas.load(); const journal = await Journal.open(join(root, 'rows.jsonl'), () => 0); assert.ok(journal.ok);
  const identity = new Identity({ people: [], authorities: {}, bindings: [] }, () => 0); const token = identity.issue({ id: 'metrics', person: '', scope: 'deployment', target: 'metrics', generation: 1, services: [] }); assert.ok(token.ok);
  const repository = new URL('..', import.meta.url).pathname.replace(/\/$/u, '');
  const methods = new Map<Method, Operation>([['health.probe', () => Promise.resolve({ ok: true, value: { ready: true } })], ['profile.get', () => Promise.resolve({ ok: true, value: {} })]]);
  const started = await Process.start({ name: 'fixture', version: '1.0.0', entry: packageEntry(repository, 'metrics', 'service.ts'), args: [], cwd: '/tmp', mounts: [
    ...packageMounts(repository, ['metrics']), { source: join(root, 'endpoint'), path: '/endpoint', mode: 'rw', maximumBytes: 67108864 }
  ] }, token.value, { target: 'metrics', identity, schemas, clock: new ManualClock(), journal: journal.value, runner: new SandboxRunner('/cgroup'), operations: { methods, notes: ['run.stop', 'env.updated'], note: () => Promise.resolve({ ok: true, value: undefined }) } }); assert.ok(started.ok);
  try {
    assert.ok((await started.value.probe()).ok); const connection = await connect(join(root, 'endpoint/service.sock')); assert.ok(connection.ok);
    try {
      const fixture = evidence('candidate'); assert.ok((await send(connection.value, { v: '1', method: 'summary', ...fixture })).ok);
      const response = await socketFrames(connection.value).next(); assert.ok(!response.done && response.value.ok);
      assert.ok(isObject(response.value.value) && response.value.value['ok'] === true, JSON.stringify(response.value));
      assert.ok(!JSON.stringify(response.value.value).includes('"task"')); assert.ok(!JSON.stringify(response.value.value).includes('code'));
    } finally { connection.value.destroy(); }
  } finally { assert.ok((await started.value.stop('test complete')).ok); await journal.value.close(); await rm(root, { recursive: true, force: true }); }
});
