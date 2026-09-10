/** Inspect actual candidate and scorer mounts through the mandatory adapter; EV-002. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Mount } from '@/lib/sandbox-runner/index.ts';
import { SandboxRunner } from '@/lib/sandbox-runner/index.ts';
import { socketPair } from '@/lib/socket/pair.ts';
import { ManualClock } from '@/lib/events/index.ts';
import { Scorer } from './scorer.ts';

await test('EV-002 private suite, seeds and checks are absent from candidate mounts and scorer spaces are read-only', async () => {
  const root = await mkdtemp('/tmp/evaluation-boundary-'); const space = join(root, 'space'); await mkdir(space);
  const checks = join(root, 'run.sh'); await writeFile(checks, 'test -f /space/result && ! touch /space/forbidden 2>/dev/null\n'); await writeFile(join(space, 'result'), 'done');
  const pair = await socketPair(); assert.ok(pair.ok); const runner = new SandboxRunner('/cgroup');
  const repository = new URL('../..', import.meta.url).pathname.replace(/\/$/u, '');
  try {
    const started = await runner.start({ name: 'candidate', version: '1.0.0', entry: `${repository}/test/fixtures/evaluation-candidate.ts`, cwd: '/space', args: [], socket: pair.value.client, token: 'ordinary-run', mounts: [
      ...['lib', 'contracts', 'node_modules', 'test/fixtures'].map((name): Mount => ({ source: `${repository}/${name}`, path: `${repository}/${name}`, mode: 'ro' })), { source: space, path: '/space', mode: 'rw', maximumBytes: 67108864 }
    ] }); assert.ok(started.ok, JSON.stringify(started));
    let output = ''; started.value.process.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); assert.ok(output.length < 4096); });
    assert.equal((await started.value.exited).code, 0); assert.ok((await started.value.dispose()).ok);
    const rows: unknown = JSON.parse(output); assert.ok(Array.isArray(rows)); assert.equal(rows.length, 3);
    assert.equal((output.match(/outside-roots/gu) ?? []).length, 3); assert.equal((output.match(/"exists":false/gu) ?? []).length, 3);
    const authority = await socketPair(); assert.ok(authority.ok);
    try {
      const result = await new Scorer(runner, new ManualClock()).run({ checks, snapshot: space, authority: { socket: authority.value.client, token: 'reviewed-scorer-run' } });
      assert.ok(result.ok, JSON.stringify(result)); assert.equal(result.value.pass, true);
    } finally { assert.ok((await authority.value.close()).ok); }
  } finally { assert.ok((await pair.value.close()).ok); await rm(root, { recursive: true, force: true }); }
});

await test('ADR-0004 scorer failures, output overflow and deadlines remain typed outcomes', async () => {
  const root = await mkdtemp('/tmp/scorer-failures-'); const runner = new SandboxRunner('/cgroup');
  class DeadlineClock extends ManualClock {
    readonly waiting = Promise.withResolvers<undefined>();
    override wait(milliseconds: number, signal?: AbortSignal): Promise<void> { const value = super.wait(milliseconds, signal); this.waiting.resolve(undefined); return value; }
  }
  try {
    for (const [script, expected] of [['exit 9', 'failed'], ['head -c 70000 /dev/zero', 'budget'], ['while :; do :; done', 'deadline']]) {
      assert.ok(script && expected); const checks = join(root, 'run.sh'); await writeFile(checks, script);
      const pair = await socketPair(); assert.ok(pair.ok); const clock = new DeadlineClock();
      try {
        const pending = new Scorer(runner, clock).run({ checks, snapshot: root, authority: { socket: pair.value.client, token: 'scorer-run' } });
        if (expected === 'deadline') { await clock.waiting.promise; clock.advance(10000); }
        const result = await pending;
        if (expected === 'failed') { assert.ok(result.ok); assert.equal(result.value.pass, false); assert.equal(result.value.exit, 9); }
        else { assert.ok(!result.ok); assert.equal(result.error.code, expected); }
      } finally { assert.ok((await pair.value.close()).ok); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
