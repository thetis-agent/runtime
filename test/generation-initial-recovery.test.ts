/** Restore an initially migrated generation without repeating its migration; ADR 0043, KS-019. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Driver } from '@/kernel/generations/driver.ts';
import { Identity } from '@/kernel/identity/index.ts';
import { recover } from '@/lib/generation-state/index.ts';
import { isObject } from '@/lib/schema/index.ts';
import { snapshot } from '@/lib/snapshots/index.ts';
import { endpointVersion, person, processGeneration, revision } from '@/test/process-generation.ts';

async function initiallyMigrated() {
  const fixture = await processGeneration();
  try {
    const initial = await revision(fixture.root, 'initial', 'healthy', 2, true);
    const entry = initial.pins['entry']; assert.ok(entry);
    await writeFile(join(entry.source, 'migrate.ts'), [
      '/** Refuse a repeated migration so recovery must restore its recorded result; ADR 0043. */',
      "import { readFile, writeFile } from 'node:fs/promises';",
      "const state = JSON.parse(await readFile('/state/value.json', 'utf8'));",
      "if (state.version !== 1) throw new Error('The initial migration must run exactly once.');",
      "await writeFile('/state/value.json', JSON.stringify({ version: 2 }));",
      ''
    ].join('\n'));
    const pinned = await snapshot(entry.source); assert.ok(pinned.ok);
    const prepared = { ...initial, pins: { entry: { ...entry, hash: pinned.value } } };
    const config = { root: join(fixture.root, 'initial-target'), owner: person.id, context: { ...fixture.context, target: 'initial-migration' } };
    const started = await Driver.start(config, prepared, join(fixture.root, 'state'), { n: 1, pins: { entry: pinned.value }, stateSnapshot: '', prefixRenderer: '1', at: 0 });
    assert.ok(started.ok, JSON.stringify(started));
    const driver = started.value;
    return { driver, config, revision: prepared, root: fixture.root, async migrations() {
      return (await fixture.rows()).trim().split('\n').map((row): unknown => JSON.parse(row)).filter(isObject)
        .filter(row => row['target'] === config.context.target && row['kind'] === 'migration.exit');
    }, async close() {
      const stopped = await driver.process.stop('initial migration test complete');
      await fixture.close(); assert.ok(stopped.ok, JSON.stringify(stopped));
    } };
  } catch (error) { await fixture.close(); throw error; }
}

await test('ADR-0043 crash reset restores the initially migrated healthy snapshot without repeating migration', async () => {
  const fixture = await initiallyMigrated(); const { driver } = fixture;
  try {
    assert.deepEqual(JSON.parse(await readFile(join(driver.state, 'value.json'), 'utf8')), { version: 2 });
    const healthy = driver.machine.view.current;
    await writeFile(join(driver.state, 'value.json'), JSON.stringify({ version: 99 }));
    assert.ok(driver.process.running.process.kill('SIGKILL'));
    assert.ok((await driver.exited).ok);
    assert.equal(driver.machine.view.state, 'FAILED'); assert.equal(driver.admits, false);
    const restored = await driver.reset(person); assert.ok(restored.ok, JSON.stringify(restored));
    assert.equal(driver.machine.view.current.n, healthy.n + 1); assert.equal(driver.admits, true);
    assert.deepEqual(driver.machine.view.current.pins, healthy.pins);
    assert.equal(driver.machine.view.current.stateSnapshot, healthy.stateSnapshot);
    assert.deepEqual(JSON.parse(await readFile(join(driver.state, 'value.json'), 'utf8')), { version: 2 });
    assert.equal(await endpointVersion(driver.endpoint), 'initial');
    assert.equal((await fixture.migrations()).length, 1);
  } finally { await fixture.close(); }
});

await test('ADR-0043 supervisor recovery skips a non-idempotent initial migration', async () => {
  const fixture = await initiallyMigrated(); let restarted: Driver | undefined;
  try {
    assert.ok((await fixture.driver.process.stop('supervisor stopped')).ok);
    const recovered = await recover(join(fixture.root, 'observed.jsonl'), fixture.config.context.target, fixture.config.context.schemas);
    assert.ok(recovered.ok && recovered.value);
    const context = { ...fixture.config.context, identity: new Identity({ people: [person], authorities: {}, bindings: [] }, () => fixture.config.context.clock.now()) };
    const started = await Driver.start({ ...fixture.config, context, recovered: recovered.value }, { ...fixture.revision, pins: fixture.driver.pins }, fixture.driver.state, recovered.value.current);
    assert.ok(started.ok, JSON.stringify(started)); restarted = started.value;
    assert.equal(restarted.admits, true); assert.equal(restarted.machine.view.current.n, recovered.value.current.n + 1);
    assert.deepEqual(restarted.machine.view.current.pins, recovered.value.current.pins);
    assert.deepEqual(JSON.parse(await readFile(join(restarted.state, 'value.json'), 'utf8')), { version: 2 });
    assert.equal(await endpointVersion(restarted.endpoint), 'initial');
    assert.equal((await fixture.migrations()).length, 1);
  } finally {
    const stopped = await restarted?.process.stop('supervisor recovery test complete');
    await fixture.close(); if (stopped) assert.ok(stopped.ok, JSON.stringify(stopped));
  }
});
