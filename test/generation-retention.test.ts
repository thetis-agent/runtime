/** Exercise workspace reclamation through real sandboxed switching and undo; GN-002, ADR 0046. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { processGeneration, endpointVersion, person } from '@/test/process-generation.ts';
import { limits } from '@/kernel/generations/prepare.ts';
import { Driver } from '@/kernel/generations/driver.ts';
import { activeRuns } from '@/lib/snapshots/retention.ts';

await test('GN-002 repeated real switches and undo release run capacity while preserving prior immutable pins', async () => {
  const maximum = limits.generations; limits.generations = 3;
  const f = await processGeneration();
  try {
    const old = f.driver.pins['entry']; assert.ok(old);
    for (let n = 0; n < 6; n++) {
      const switched = await f.driver.switch(f.next, f.driver.machine.view.current.n, person); assert.ok(switched.ok, JSON.stringify(switched));
      assert.equal(await endpointVersion(f.driver.endpoint), 'new');
      assert.deepEqual(await activeRuns(join(f.root, 'target/runs')), { ok: true, value: 1 });
    }
    assert.equal(await readFile(join(old.source, 'version'), 'utf8'), 'old');
    const reset = await f.driver.reset(person); assert.ok(reset.ok, JSON.stringify(reset));
    assert.equal(await endpointVersion(f.driver.endpoint), 'new');
    assert.deepEqual(await activeRuns(join(f.root, 'target/runs')), { ok: true, value: 1 });
    assert.equal((await readdir(join(f.root, 'target/pins'))).length, 2);
  } finally { limits.generations = maximum; await f.close(); }
});

await test('GN-002 restart reclaims a full legacy run pool after preserving its current state and pin anchors', async () => {
  const maximum = limits.generations; limits.generations = 3;
  const f = await processGeneration(); let restarted: Driver | undefined;
  try {
    const state = f.driver.state; const view = f.driver.machine.view;
    assert.ok((await f.driver.process.stop('supervisor restart')).ok);
    for (let n = 0; n < 3; n++) {
      const legacy = join(f.root, 'target/runs', `legacy-${String(n)}`);
      await mkdir(join(legacy, 'state'), { recursive: true }); await mkdir(join(legacy, 'pins/package'), { recursive: true });
      await writeFile(join(legacy, 'pins/package/source'), 'historical pin');
    }
    const started = await Driver.start({ root: join(f.root, 'target'), owner: person.id, context: f.context, recovered: view }, f.old, state, view.current);
    assert.ok(started.ok, JSON.stringify(started)); restarted = started.value;
    assert.equal(await endpointVersion(restarted.endpoint), 'old');
    assert.deepEqual(await activeRuns(join(f.root, 'target/runs')), { ok: true, value: 1 });
    assert.equal(await readFile(join(f.root, 'target/runs/legacy-0/pins/package/source'), 'utf8'), 'historical pin');
    assert.deepEqual(await readdir(join(f.root, 'target/runs/legacy-0')), ['pins']);
  } finally { if (restarted) assert.ok((await restarted.process.stop('test complete')).ok); limits.generations = maximum; await f.close(); }
});
