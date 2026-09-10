/** Recover checkpoint failures and observed exits through real generation effects; ADR 0043, KS-019. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { processGeneration, person, endpointVersion } from '@/test/process-generation.ts';
import { atomicWrite } from '@/lib/files/atomic.ts';

for (const phase of ['QUIESCING', 'FROZEN']) await test(`ADR-0043 a ${phase} checkpoint failure restores admission and permits another switch`, async () => {
  let refused = false;
  const f = await processGeneration('healthy', (view, prepared) => {
    const deny = view.state === phase && !refused; refused ||= deny;
    return atomicWrite(deny ? '/workspace/readonly-checkpoint.json' : join(dirname(dirname(prepared.root)), 'checkpoint.json'), Buffer.from(JSON.stringify(view)));
  });
  try {
    await writeFile(join(f.driver.state, 'latest.json'), '{"preserved":true}');
    const result = await f.driver.switch(f.next, 1, person); assert.ok(!result.ok);
    assert.equal(refused, true); assert.equal(f.driver.machine.view.state, 'LIVE'); assert.equal(f.driver.admits, true);
    assert.equal(await endpointVersion(f.driver.endpoint), 'old');
    assert.equal(await readFile(join(f.driver.state, 'latest.json'), 'utf8'), '{"preserved":true}');
    assert.match(await f.rows(), /"to":"ROLLING_BACK"/u);
    assert.ok((await f.driver.switch(f.next, f.driver.machine.view.current.n, person)).ok);
    assert.equal(await endpointVersion(f.driver.endpoint), 'new');
  } finally { await f.close(); }
});

await test('ADR-0043 repeated checkpoint failures stop the target and storage repair permits reset', async () => {
  let failed = false;
  const f = await processGeneration('healthy', (view, prepared) => {
    failed ||= view.state === 'FROZEN';
    return atomicWrite(failed ? '/workspace/readonly-checkpoint.json' : join(dirname(dirname(prepared.root)), 'checkpoint.json'), Buffer.from(JSON.stringify(view)));
  });
  try {
    const result = await f.driver.switch(f.next, 1, person); assert.ok(!result.ok);
    assert.equal(f.driver.machine.view.state, 'FAILED'); assert.equal(f.driver.admits, false);
    assert.equal(f.driver.process.alive, false);
    failed = false;
    assert.ok((await f.driver.reset(person)).ok);
    assert.equal(f.driver.admits, true); assert.equal(await endpointVersion(f.driver.endpoint), 'old');
  } finally { await f.close(); }
});

await test('ADR-0043 a serving crash records FAILED and reset restores its migrated healthy snapshot', async () => {
  const f = await processGeneration();
  try {
    assert.ok((await f.driver.switch(f.next, 1, person)).ok);
    await writeFile(join(f.driver.state, 'value.json'), JSON.stringify({ version: 99 }));
    await writeFile(join(f.root, 'work', 'repair.ts'), 'preserved work');
    const crashed = f.driver.process; assert.ok(crashed.running.process.kill('SIGKILL'));
    await crashed.running.exited;
    assert.equal(f.driver.admits, false);
    assert.ok((await f.driver.exited).ok);
    assert.equal(f.driver.machine.view.state, 'FAILED');
    assert.ok(!(await f.driver.invoke('session.submit', { conversation: 'after-crash', input: {} })).ok);
    assert.match(await f.rows(), /"event":"crashed"/u);
    assert.ok((await f.driver.reset(person)).ok);
    assert.equal(f.driver.machine.view.current.n, 3); assert.equal(f.driver.admits, true);
    assert.equal(await endpointVersion(f.driver.endpoint), 'new');
    assert.deepEqual(JSON.parse(await readFile(join(f.driver.state, 'value.json'), 'utf8')), { version: 2 });
    assert.equal(await readFile(join(f.root, 'work', 'repair.ts'), 'utf8'), 'preserved work');
  } finally { await f.close(); }
});

await test('ADR-0043 a crash during an open transaction is settled by that transaction before supervision', async () => {
  const f = await processGeneration();
  try {
    assert.ok((await f.driver.quiesce(f.next, 1, person)).ok);
    const old = f.driver.process; assert.ok(old.running.process.kill('SIGKILL')); await old.exited;
    assert.ok((await f.driver.stage()).ok);
    assert.ok((await f.driver.commit()).ok);
    assert.equal(f.driver.machine.view.state, 'LIVE'); assert.equal(f.driver.admits, true);
    assert.equal(await endpointVersion(f.driver.endpoint), 'new');
    assert.doesNotMatch(await f.rows(), /"event":"crashed"/u);
  } finally { await f.close(); }
});

for (const migrate of ['stop', 'shared'] satisfies ('stop' | 'shared')[]) await test(`ADR-0043 a ${migrate} LIVE checkpoint failure retains the committed pins and permits reset`, async () => {
  let refused = false;
  const f = await processGeneration('healthy', (view, prepared) => {
    const deny = view.state === 'LIVE' && view.current.n === 2 && !refused; refused ||= deny;
    return atomicWrite(deny ? '/workspace/readonly-checkpoint.json' : join(dirname(dirname(prepared.root)), 'checkpoint.json'), Buffer.from(JSON.stringify({ view, pins: prepared.pins, state: prepared.state })));
  });
  try {
    const result = await f.driver.switch({ ...f.next, migrate }, 1, person); assert.ok(!result.ok);
    assert.equal(refused, true); assert.equal(f.driver.machine.view.state, 'FAILED'); assert.equal(f.driver.machine.view.current.n, 2);
    assert.equal(f.driver.admits, false); assert.equal(f.driver.process.alive, false);
    assert.deepEqual(Object.fromEntries(Object.entries(f.driver.pins).map(([name, pin]) => [name, pin.hash])), f.driver.machine.view.current.pins);
    const checkpoint: unknown = JSON.parse(await readFile(join(f.root, 'target/checkpoint.json'), 'utf8'));
    assert.deepEqual(checkpoint, { view: f.driver.machine.view, pins: f.driver.pins, state: f.driver.state });
    assert.ok((await f.driver.reset(person)).ok);
    assert.equal(f.driver.machine.view.current.n, 3); assert.equal(f.driver.admits, true);
    assert.equal(await endpointVersion(f.driver.endpoint), 'new');
    assert.deepEqual(JSON.parse(await readFile(join(f.driver.state, 'value.json'), 'utf8')), { version: 2 });
  } finally { await f.close(); }
});

await test('ADR-0043 a reset checkpoint refusal returns to FAILED and a later reset succeeds', async () => {
  let refuse = false;
  const f = await processGeneration('healthy', (view, prepared) => {
    const deny = refuse && view.state === 'ROLLING_BACK'; if (deny) refuse = false;
    return atomicWrite(deny ? '/workspace/readonly-checkpoint.json' : join(dirname(dirname(prepared.root)), 'checkpoint.json'), Buffer.from(JSON.stringify(view)));
  });
  try {
    assert.ok(f.driver.process.running.process.kill('SIGKILL')); assert.ok((await f.driver.exited).ok);
    refuse = true; assert.ok(!(await f.driver.reset(person)).ok);
    assert.equal(f.driver.machine.view.state, 'FAILED'); assert.equal(f.driver.admits, false);
    assert.ok((await f.driver.reset(person)).ok); assert.equal(f.driver.admits, true);
  } finally { await f.close(); }
});

await test('ADR-0043 a failed recovery reserves its epoch before fencing and a retry uses a higher epoch', async () => {
  const f = await processGeneration();
  try {
    assert.ok(f.driver.process.running.process.kill('SIGKILL')); assert.ok((await f.driver.exited).ok);
    const retained = join(f.root, 'target/snapshots', f.driver.machine.view.current.stateSnapshot.slice(7)); const unavailable = join(f.root, 'unavailable-snapshot');
    await rename(retained, unavailable);
    const failed = await f.driver.reset(person); assert.ok(!failed.ok);
    assert.equal(f.driver.machine.view.state, 'FAILED');
    const reserved = f.driver.machine.view.candidate?.n; assert.equal(reserved, 2);
    await rename(unavailable, retained);
    assert.ok((await f.driver.reset(person)).ok);
    assert.equal(f.driver.machine.view.current.n, 3); assert.equal(f.driver.admits, true);
    assert.equal(await endpointVersion(f.driver.endpoint), 'old');
  } finally { await f.close(); }
});

await test('ADR-0043 a restored LIVE checkpoint refusal adopts the restored generation before failing it', async () => {
  let refuse = false;
  const f = await processGeneration('healthy', (view, prepared) => {
    const deny = refuse && view.state === 'LIVE'; if (deny) refuse = false;
    return atomicWrite(deny ? '/workspace/readonly-checkpoint.json' : join(dirname(dirname(prepared.root)), 'checkpoint.json'), Buffer.from(JSON.stringify(view)));
  });
  try {
    assert.ok(f.driver.process.running.process.kill('SIGKILL')); assert.ok((await f.driver.exited).ok);
    refuse = true; assert.ok(!(await f.driver.reset(person)).ok);
    assert.equal(f.driver.machine.view.state, 'FAILED'); assert.equal(f.driver.machine.view.current.n, 2);
    assert.match(f.driver.state, /\/2-recovery-[^/]+\/state$/u); assert.equal(f.driver.process.alive, false);
    assert.ok((await f.driver.reset(person)).ok);
    assert.equal(f.driver.machine.view.current.n, 3); assert.equal(f.driver.admits, true);
  } finally { await f.close(); }
});

await test('ADR-0043 promotion accepts a stopped private probe that removed its own socket', async () => {
  const f = await processGeneration('healthy', async (view, prepared) => {
    if (view.state === 'SWITCHING') {
      const candidate = view.candidate; assert.ok(candidate);
      await unlink(join(dirname(prepared.root), String(candidate.n), 'endpoint/private.sock'));
    }
    return atomicWrite(join(dirname(dirname(prepared.root)), 'checkpoint.json'), Buffer.from(JSON.stringify(view)));
  });
  try {
    const switched = await f.driver.switch(f.next, 1, person); assert.ok(switched.ok, JSON.stringify(switched));
    assert.equal(f.driver.admits, true); assert.equal(await endpointVersion(f.driver.endpoint), 'new');
  } finally { await f.close(); }
});
