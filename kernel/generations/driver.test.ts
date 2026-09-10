/** Exercise the complete switch with real processes, hashes, migrations and endpoints; GN-002–006. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { processGeneration, person, endpointVersion } from '@/test/process-generation.ts';
import { snapshot } from '@/lib/snapshots/index.ts';
import { isObject } from '@/lib/schema/index.ts';

function writes(rows: string, action: string, expected: readonly string[]): void {
  const values = rows.trim().split('\n').map((row): unknown => JSON.parse(row));
  const found = values.find(row => isObject(row) && row['kind'] === 'generation.writes' && isObject(row['data']) && row['data']['action'] === action);
  assert.ok(isObject(found) && isObject(found['data']) && Array.isArray(found['data']['paths']));
  const paths: unknown[] = found['data']['paths']; const application: string[] = [];
  for (const path of paths) {
    assert.equal(typeof path, 'string'); assert.ok(typeof path === 'string');
    if (path.startsWith('.node-compile-cache/')) assert.match(path, /^\.node-compile-cache\/[^/]+\/[a-f0-9]+$/u);
    else application.push(path);
  }
  assert.deepEqual(application, expected);
}

await test('GN-002 unchanged pins reuse only the driver’s verified immutable copies', async () => {
  const f = await processGeneration();
  try {
    assert.ok((await f.driver.switch(f.next, 1, person)).ok);
    const retained = f.driver.pins['entry']; assert.ok(retained);
    const original = f.next.pins['entry']; assert.ok(original);
    const switched = await f.driver.switch({ ...f.next, pins: { entry: { ...original, source: '/absent-untrusted-source' } } }, 2, person);
    assert.ok(switched.ok, JSON.stringify(switched));
    assert.equal(f.driver.pins['entry']?.source, retained.source);
    assert.equal(await endpointVersion(f.driver.endpoint), 'new');
  } finally { await f.close(); }
});

await test('GN-004 a real switch serves the new pinned process and ADR-0026 denies shared writes during the private probe', async () => {
  const f = await processGeneration();
  try {
    assert.equal(await endpointVersion(f.driver.endpoint), 'old');
    const result = await f.driver.switch(f.next, 1, person); assert.ok(result.ok, JSON.stringify(result));
    assert.equal(f.driver.machine.view.state, 'LIVE'); assert.equal(f.driver.machine.view.current.n, 2);
    assert.equal(await endpointVersion(f.driver.endpoint), 'new');
    assert.deepEqual(JSON.parse(await readFile(join(f.root, 'target/runs/2/endpoint/readonly.json'), 'utf8')), { writable: false });
    assert.deepEqual(JSON.parse(await readFile(join(f.root, 'target/runs/2/endpoint/writable.json'), 'utf8')), { writable: true });
    assert.deepEqual(JSON.parse(await readFile(join(f.driver.state, 'value.json'), 'utf8')), { version: 2 });
  } finally { await f.close(); }
});

await test('GN-002 a bad pin rolls back the real process with byte-identical state', async () => {
  const f = await processGeneration();
  try {
    const before = await snapshot(f.driver.state); const pin = f.next.pins['entry']; assert.ok(pin);
    const result = await f.driver.switch({ ...f.next, pins: { entry: { ...pin, hash: `sha256:${'0'.repeat(64)}` } } }, 1, person);
    assert.ok(!result.ok); assert.equal(f.driver.machine.view.state, 'LIVE'); assert.equal(f.driver.machine.view.current.n, 1);
    assert.deepEqual(await snapshot(f.driver.state), before); assert.equal(await endpointVersion(f.driver.endpoint), 'old');
    assert.match(await f.rows(), /ROLLING_BACK/u);
  } finally { await f.close(); }
});

await test('GN-003 a real candidate probe timeout removes the candidate and restores the old endpoint', async () => {
  const f = await processGeneration('unhealthy');
  try {
    const switched = f.driver.switch(f.next, 1, person);
    assert.ok(await Promise.race([f.probing.then(() => true), switched.then(() => false)]), 'The candidate must reach its probe.'); f.clock.advance(10000);
    const duplicate = await f.driver.switch(f.next, 1, person); assert.ok(!duplicate.ok); assert.equal(duplicate.error.code, 'switching');
    const admitted = await f.driver.invoke('session.submit', { conversation: 'new', input: {} }); assert.ok(!admitted.ok); assert.equal(admitted.error.code, 'switching');
    const result = await switched; assert.ok(!result.ok); assert.equal(f.driver.machine.view.state, 'LIVE');
    assert.equal(f.driver.machine.view.current.n, 1); assert.equal(await endpointVersion(f.driver.endpoint), 'old');
    assert.match(await f.rows(), /candidate refused/u);
  } finally { await f.close(); }
});

await test('GN-004 a serving failure after fencing restores old pins in a fresh epoch and lists discarded state writes', async () => {
  const f = await processGeneration('fail-serving');
  try {
    const result = await f.driver.switch(f.next, 1, person); assert.ok(!result.ok);
    assert.equal(f.driver.machine.view.state, 'LIVE'); assert.equal(f.driver.machine.view.current.n, 3);
    assert.equal(await endpointVersion(f.driver.endpoint), 'old');
    assert.deepEqual(JSON.parse(await readFile(join(f.driver.state, 'value.json'), 'utf8')), { version: 1 });
    writes(await f.rows(), 'rollback', ['post-commit.json', 'value.json']);
  } finally { await f.close(); }
});

await test('GN-004 unauthorized and stale switches leave the live process serving; shared migration traverses DRAINING', async () => {
  const f = await processGeneration();
  try {
    const denied = await f.driver.switch(f.next, 1, { ...person, id: 'bob' }); assert.ok(!denied.ok); assert.equal(denied.error.code, 'forbidden');
    const stale = await f.driver.switch(f.next, 0, person); assert.ok(!stale.ok); assert.equal(stale.error.code, 'baseline-moved');
    assert.equal(await endpointVersion(f.driver.endpoint), 'old');
    const result = await f.driver.switch({ ...f.next, migrate: 'shared' }, 1, person); assert.ok(result.ok, JSON.stringify(result));
    assert.equal(await endpointVersion(f.driver.endpoint), 'new'); assert.match(await f.rows(), /"to":"DRAINING"/u);
  } finally { await f.close(); }
});

await test('GN-006 undo restores the previous pins and pre-migration snapshot under a higher number', async () => {
  const f = await processGeneration();
  try {
    const pins = f.driver.machine.view.current.pins;
    assert.ok((await f.driver.switch(f.next, 1, person)).ok);
    const result = await f.driver.undo(person); assert.ok(result.ok, JSON.stringify(result));
    assert.equal(f.driver.machine.view.current.n, 3); assert.deepEqual(f.driver.machine.view.current.pins, pins);
    writes(await f.rows(), 'undo', ['value.json']);
    assert.deepEqual(JSON.parse(await readFile(join(f.driver.state, 'value.json'), 'utf8')), { version: 1 });
    assert.equal(await endpointVersion(f.driver.endpoint), 'old');
  } finally { await f.close(); }
});

await test('GN-002 migration exit and state format failures preserve the old snapshot', async () => {
  const f = await processGeneration();
  try {
    const before = await snapshot(f.driver.state);
    for (const revision of [
      { ...f.next, migrations: [{ entry: '/revision/migrate.ts', args: ['fail'] }] },
      { ...f.next, formats: [{ path: 'value.json', schema: { type: 'object', properties: { version: { const: 3 } } } }] }
    ]) {
      const result = await f.driver.switch(revision, 1, person); assert.ok(!result.ok);
      assert.equal(f.driver.machine.view.state, 'LIVE'); assert.deepEqual(await snapshot(f.driver.state), before);
      assert.equal(await endpointVersion(f.driver.endpoint), 'old');
    }
  } finally { await f.close(); }
});

await test('GN-001 the complete switch reports the stuck conversation to the new generation', async () => {
  const f = await processGeneration();
  try {
    const cooperative = f.driver.invoke('session.submit', { conversation: 'cooperative', input: {} });
    const stuck = f.driver.invoke('session.submit', { conversation: 'stuck', input: {} });
    let active: unknown;
    for (let attempt = 0; attempt < 32 && active !== 2; attempt++) {
      const status = await f.driver.process.control.call('health.probe', {}); assert.ok(status.ok); assert.ok(isObject(status.value)); active = status.value['active'];
    }
    assert.equal(active, 2);
    const switched = f.driver.switch(f.next, 1, person); assert.ok((await cooperative).ok); f.clock.advance(30000);
    const result = await switched; assert.ok(result.ok, JSON.stringify(result)); assert.ok(!(await stuck).ok);
    assert.ok((await f.driver.process.probe()).ok);
    assert.deepEqual(JSON.parse(await readFile(join(f.root, 'target/runs/2/endpoint/update.json'), 'utf8')), { generation: 2, resume: true, writes: [], interrupted: ['stuck'] });
  } finally { await f.close(); }
});

await test('KS-019 reset restores the last healthy pins and state while preserving work edits', async () => {
  const f = await processGeneration();
  try {
    assert.ok((await f.driver.switch(f.next, 1, person)).ok);
    await writeFile(join(f.root, 'work', 'edit.ts'), 'preserved work');
    assert.ok((await f.driver.reset(person)).ok);
    assert.equal(await endpointVersion(f.driver.endpoint), 'old');
    assert.deepEqual(JSON.parse(await readFile(join(f.driver.state, 'value.json'), 'utf8')), { version: 1 });
    assert.equal(await readFile(join(f.root, 'work', 'edit.ts'), 'utf8'), 'preserved work');
    assert.equal(f.driver.machine.view.current.n, 3);
  } finally { await f.close(); }
});
