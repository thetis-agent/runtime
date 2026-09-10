/** Run both CLI entry forms inside real mandatory sandboxes; KS-001, KS-004. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionFixture } from './session-fixture.ts';
import { cliOperations } from './cli-fixture.ts';
import { Journal } from '../kernel/log/index.ts';
import { Process } from '../kernel/boundary/process.ts';
import type { Context } from '../kernel/boundary/process.ts';
import { SandboxRunner } from '../lib/sandbox-runner/index.ts';
import { connect, send, socketFrames } from '../lib/ndjson/socket.ts';
import { packageEntry, packageMounts } from './package-mounts.ts';

export async function cliProcess(entry: 'main' | 'service', args: string[] = []) {
  const f = await sessionFixture(); await mkdir(join(f.root, 'cli-state')); await mkdir(join(f.root, 'cli-endpoint'));
  const journal = await Journal.open(join(f.root, 'cli-rows.jsonl'), () => f.runtime.clock.now()); assert.ok(journal.ok);
  const context: Context = { target: 'person', identity: f.provider.identity, schemas: f.runtime.schemas, clock: f.runtime.clock, journal: journal.value, runner: new SandboxRunner('/cgroup'), operations: cliOperations(f) };
  const repository = new URL('..', import.meta.url).pathname.replace(/\/$/u, '');
  const started = await Process.start({ name: 'fixture', version: '1.0.0', entry: packageEntry(repository, 'cli', `${entry}.ts`), args, cwd: '/state', mounts: [
    ...packageMounts(repository, ['cli']),
    { source: join(f.root, 'cli-state'), path: '/state', mode: 'rw', maximumBytes: 67108864 },
    { source: join(f.root, 'cli-endpoint'), path: '/endpoint', mode: 'rw', maximumBytes: 67108864 }
  ] }, f.provider.token, context); assert.ok(started.ok, JSON.stringify(started));
  return { ...f, process: started.value, socket: join(f.root, 'cli-endpoint/service.sock'), async close() {
    assert.ok((await started.value.stop('test complete')).ok); await journal.value.close(); await f.close();
  } };
}

export async function cliRequest(path: string, args: readonly string[]): Promise<unknown> {
  const connected = await connect(path); assert.ok(connected.ok);
  try {
    assert.ok((await send(connected.value, { args })).ok);
    for await (const frame of socketFrames(connected.value)) { assert.ok(frame.ok); return frame.value; }
    throw new Error('The command service ended without a result.');
  } finally { connected.value.destroy(); }
}
