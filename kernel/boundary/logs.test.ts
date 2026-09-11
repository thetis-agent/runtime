/** env.logs refuses before it reads, and never past the ownership rule env.status already applies; KS-019, ADR 0014. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Runtime } from '@/kernel/boundary/runtime.ts';
import { Identity } from '@/kernel/identity/index.ts';
import type { Principal } from '@/kernel/identity/index.ts';
import { Journal } from '@/kernel/log/index.ts';
import { ManualClock } from '@/lib/events/index.ts';
import { SandboxRunner } from '@/lib/sandbox-runner/index.ts';
import { Schemas } from '@/lib/schema/index.ts';

const alice: Principal = { id: 'alice', role: 'user', projects: [], observeOthers: false };

async function runtime(withJournal: boolean): Promise<{ value: Runtime; root: string; close(): Promise<void> }> {
  const root = await mkdtemp('/tmp/env-logs-'); const path = join(root, 'observed.jsonl');
  await writeFile(path, `${JSON.stringify({ provenance: 'kernel-observed', at: 1, target: alice.id, kind: 'process.start', data: { pid: 1 } })}\n`);
  const schemas = new Schemas(); await schemas.load();
  const journal = await Journal.open(join(root, 'kernel.jsonl'), () => 0); assert.ok(journal.ok);
  const identity = new Identity({ people: [alice], bindings: [], authorities: {} }, () => 0);
  const value = new Runtime({ root: join(root, 'targets'), ...(withJournal ? { recoveryJournal: path } : {}),
    identity, journal: journal.value, schemas, clock: new ManualClock(), runner: new SandboxRunner('/cgroup') });
  return { value, root, close: async () => { await journal.value.close(); await rm(root, { recursive: true, force: true }); } };
}

await test('KS-019 env.logs refuses a deployment that retains no observed journal', async () => {
  const built = await runtime(false);
  try {
    const refused = await built.value.logs(alice, alice.id, {});
    assert.ok(!refused.ok); assert.equal(refused.error.code, 'unsupported');
  } finally { await built.close(); }
});

await test('KS-019 env.logs answers for exactly the environments env.status answers for', async () => {
  const built = await runtime(true);
  try {
    const missing = await built.value.logs(alice, alice.id, {});
    assert.ok(!missing.ok); assert.equal(missing.error.code, 'not-found');
    assert.deepEqual(missing, built.value.status(alice, alice.id), 'env.logs and env.status disagree about the same target');
    const other = await built.value.logs(alice, 'bob', {});
    assert.ok(!other.ok); assert.deepEqual(other, built.value.status(alice, 'bob'));
  } finally { await built.close(); }
});
