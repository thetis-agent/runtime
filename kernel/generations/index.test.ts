/** Cover every table edge and guard without replacing the generation machine; ADR 0012, ADR 0023. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generationDriver, forward, candidate } from '../../test/generation-driver.ts';
import { transitions } from './table.ts';
import type { Input } from './index.ts';

await test('Generation forward transitions each commit one observed row and reject invalid guards', async () => {
  const driver = await generationDriver();
  try {
    for (const input of forward) {
      const before = driver.machine.view;
      assert.equal((await driver.machine.transition({ event: input.event, reason: 'missing evidence' })).ok, false);
      assert.deepEqual(driver.machine.view, before);
      const effects = await driver.move(input);
      const row = transitions.find(row => row.from === before.state && row.event === input.event); assert.ok(row);
      assert.equal(driver.machine.view.state, row.to); assert.deepEqual(effects, row.effects);
    }
    const rows = (await driver.rows()).trim().split('\n'); assert.equal(rows.length, forward.length);
    for (const row of rows) { assert.match(row, /"provenance":"kernel-observed"/u); assert.match(row, /"elapsedMs":0/u); }
    assert.equal(driver.machine.view.current.n, 2); assert.deepEqual(driver.machine.view.current.pins, candidate.pins);
  } finally { await driver.close(); }
});

for (const state of ['FROZEN', 'APPLYING', 'PROBING', 'SWITCHING', 'DRAINING']) await test(`Generation ${state} failure rolls back with an observed reason`, async () => {
  const driver = await generationDriver();
  try {
    for (const input of forward) { if (driver.machine.view.state === state) break; await driver.move(input); }
    await driver.move({ event: 'failed', reason: 'injected filesystem edge failure' });
    assert.equal(driver.machine.view.state, 'ROLLING_BACK');
    assert.equal((await driver.machine.transition({ event: 'restored', reason: 'unverified' })).ok, false);
    await driver.move({ event: 'restored', reason: 'restored', restored: true, probed: true });
    assert.equal(driver.machine.view.current.n, state === 'SWITCHING' || state === 'DRAINING' ? 3 : 1);
    assert.equal(driver.machine.view.current.pins['release'], 'sha256:old');
    assert.match(await driver.rows(), /injected filesystem edge failure/u);
  } finally { await driver.close(); }
});

await test('Generation failed recovery stops the target and offers reset', async () => {
  const driver = await generationDriver();
  try {
    await driver.advance(2); await driver.move({ event: 'failed', reason: 'snapshot failed' });
    assert.deepEqual(await driver.move({ event: 'failed', reason: 'restore failed' }), ['stop-target', 'offer-reset']);
    assert.equal(driver.machine.view.state, 'FAILED'); assert.equal(driver.machine.admits, false);
  } finally { await driver.close(); }
});

await test('Generation drains use injected deadlines and probe compatibility is mandatory', async () => {
  const driver = await generationDriver();
  try {
    await driver.advance(1); assert.equal(driver.machine.admits, false);
    assert.equal((await driver.machine.transition({ event: 'drained', reason: 'active', active: 2 })).ok, false);
    driver.clock.advance(30000); await driver.move({ event: 'drained', reason: 'deadline', active: 2 });
    for (const input of forward.slice(2, 4)) await driver.move(input);
    assert.equal((await driver.machine.transition({ event: 'healthy', reason: 'old major', probed: true, clientCompatible: false })).ok, false);
    driver.clock.advance(10000);
    assert.equal((await driver.machine.transition({ event: 'healthy', reason: 'late', probed: true, clientCompatible: true })).ok, false);
  } finally { await driver.close(); }
});

await test('Generation undo creates a higher number with prior pins and snapshot', async () => {
  const driver = await generationDriver();
  try {
    assert.equal((await driver.machine.transition({ event: 'undo', reason: 'no snapshot', authorized: true })).ok, false);
    await driver.advance(forward.length);
    await driver.move({ event: 'undo', reason: 'undo', authorized: true });
    for (const input of forward.slice(1)) await driver.move(input);
    assert.equal(driver.machine.view.current.n, 3); assert.equal(driver.machine.view.current.stateSnapshot, 'sha256:state');
    assert.equal(driver.machine.view.current.pins['release'], 'sha256:old');
  } finally { await driver.close(); }
});

await test('Generation concurrent starts cannot interleave or admit turns', async () => {
  const driver = await generationDriver();
  try {
    const input: Input = { event: 'switch', reason: 'race', candidate, authorized: true };
    const first = driver.machine.transition(input); assert.equal(driver.machine.admits, false);
    const second = await driver.machine.transition(input); assert.ok(!second.ok); assert.equal(second.error.code, 'switching');
    assert.ok((await first).ok);
    const stale = await driver.machine.transition({ ...input, baseline: 0 }); assert.ok(!stale.ok); assert.equal(stale.error.code, 'baseline-moved');
  } finally { await driver.close(); }
});

await test('Generation stop migrations skip old connection draining through the table', async () => {
  const driver = await generationDriver();
  try {
    await driver.advance(5);
    const effects = await driver.move({ event: 'repointed', reason: 'state cannot be shared', atomic: true, stop: true });
    assert.ok(effects.includes('stop-old')); assert.equal(driver.machine.view.state, 'LIVE');
    assert.equal(driver.machine.view.current.n, 2);
  } finally { await driver.close(); }
});

await test('Generation old connection deadline admits the candidate after the bounded drain', async () => {
  const driver = await generationDriver();
  try {
    await driver.advance(6);
    assert.equal((await driver.machine.transition({ event: 'closed', reason: 'still connected', connections: 1 })).ok, false);
    driver.clock.advance(60000);
    await driver.move({ event: 'closed', reason: 'old drain elapsed', connections: 1 });
    assert.equal(driver.machine.admits, true);
  } finally { await driver.close(); }
});

await test('ADR-0025 switching intent is durable before repointing and requires fresh-epoch recovery', async () => {
  const driver = await generationDriver();
  try {
    await driver.advance(5); assert.equal(driver.machine.view.committed, true);
    const last = (await driver.rows()).trim().split('\n').at(-1); assert.ok(last); assert.match(last, /"committed":true/u);
    await driver.move({ event: 'failed', reason: 'rename failed after fencing intent' });
    await driver.move({ event: 'restored', reason: 'restored old state under a new epoch', restored: true, probed: true });
    assert.equal(driver.machine.view.current.n, 3); assert.equal(driver.machine.view.current.pins['release'], 'sha256:old');
  } finally { await driver.close(); }
});
