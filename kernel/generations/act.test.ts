/** Refuse stale, forged and unconfirmed promotion through the real gate and machine; KS-014–016, GN-005. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { actFixture, evidence, administrator, reviewer, source } from '@/test/default-act.ts';

for (const id of ['KS-014', 'EV-005']) await test(`${id} stale authorized results are stored and cannot prepare the default act`, async () => {
  const f = await actFixture();
  try {
    const old = evidence('old', '0'); assert.ok(f.act.authorize(administrator, source.target, old.plan).ok);
    const submitted = await f.act.submit(source, old.submission); assert.deepEqual(submitted, { ok: true, value: { stale: true } });
    assert.ok(!f.act.prepare(reviewer, 'kernel', { digest: 'old', baseline: 1 }).ok);
    const files = (await readdir(f.root)).filter(name => name.endsWith('.json')); assert.equal(files.length, 1);
    const file = files[0]; assert.ok(file); assert.match(await readFile(join(f.root, file), 'utf8'), /"stale":true/u);
  } finally { await f.close(); }
});

await test('KS-015 confirmation binds person, kernel origin, digest, baseline, expiry and a passing gate', async () => {
  const f = await actFixture();
  try {
    const good = evidence('good'); assert.ok(f.act.authorize(administrator, source.target, good.plan).ok); assert.ok((await f.act.submit(source, good.submission)).ok);
    const prepared = f.act.prepare(reviewer, 'kernel', { digest: 'good', baseline: 1 }); assert.ok(prepared.ok); assert.match(prepared.value.line, /good baseline 1 gate passed code/u);
    const params = { digest: 'good', baseline: 1, code: prepared.value.code };
    assert.ok(!(await f.act.set(reviewer, 'package', params)).ok);
    assert.ok(!(await f.act.set({ ...reviewer, role: 'user' }, 'kernel', params)).ok);
    assert.ok(!(await f.act.set({ ...reviewer, id: 'another' }, 'kernel', params)).ok);
    assert.ok(!(await f.act.set(reviewer, 'kernel', { ...params, code: 'wrong' })).ok);
    assert.ok(!(await f.act.set(reviewer, 'kernel', { ...params, digest: 'wrong' })).ok);
    f.advance(600000); assert.ok(!(await f.act.set(reviewer, 'kernel', params)).ok);
    assert.equal(f.machine.view.current.n, 1);
    const bad = evidence('bad', '1', false); assert.ok(f.act.authorize(administrator, source.target, bad.plan).ok); assert.ok((await f.act.submit(source, bad.submission)).ok);
    assert.ok(!f.act.prepare(reviewer, 'kernel', { digest: 'bad', baseline: 1 }).ok);
  } finally { await f.close(); }
});

for (const id of ['GN-005', 'KS-016']) await test(`${id} concurrent valid default acts admit exactly one generation and refuse the moved baseline`, async () => {
  const f = await actFixture();
  try {
    const confirmations = [];
    for (const digest of ['one', 'two']) {
      const value = evidence(digest); assert.ok(f.act.authorize(administrator, source.target, value.plan).ok); assert.ok((await f.act.submit(source, value.submission)).ok);
      const prepared = f.act.prepare(reviewer, 'kernel', { digest, baseline: 1 }); assert.ok(prepared.ok); confirmations.push({ digest, baseline: 1, code: prepared.value.code });
    }
    const results = await Promise.all(confirmations.map(params => f.act.set(reviewer, 'kernel', params)));
    assert.equal(results.filter(result => result.ok).length, 1); assert.ok(results.some(result => !result.ok && result.error.code === 'baseline-moved'));
    assert.equal(f.machine.view.state, 'LIVE'); assert.equal(f.machine.view.current.n, 2); assert.equal(f.machine.view.current.pins['release'], 'one');
    assert.ok(!await f.rows().then(rows => rows.includes('candidate-reported')));
  } finally { await f.close(); }
});

await test('KS-015 accepted evidence cannot be replaced beneath a confirmation code', async () => {
  const f = await actFixture();
  try {
    const good = evidence('immutable'); assert.ok(f.act.authorize(administrator, source.target, good.plan).ok);
    assert.ok((await f.act.submit(source, good.submission)).ok);
    const prepared = f.act.prepare(reviewer, 'kernel', { digest: 'immutable', baseline: 1 }); assert.ok(prepared.ok);
    const replacement = await f.act.submit(source, evidence('immutable', '1', false).submission);
    assert.ok(!replacement.ok); assert.equal(replacement.error.code, 'conflict');
    assert.ok((await f.act.set(reviewer, 'kernel', { digest: 'immutable', baseline: 1, code: prepared.value.code })).ok);
  } finally { await f.close(); }
});

await test('EV-005 the same candidate can receive new evidence against a later baseline without replacing stale evidence', async () => {
  const f = await actFixture();
  try {
    for (const baseline of ['0', '1']) {
      const value = evidence('same-candidate', baseline); assert.ok(f.act.authorize(administrator, source.target, value.plan).ok);
      assert.ok((await f.act.submit(source, value.submission)).ok);
    }
    assert.equal((await readdir(f.root)).filter(name => name.endsWith('.json')).length, 2);
    assert.ok(f.act.prepare(reviewer, 'kernel', { digest: 'same-candidate', baseline: 1 }).ok);
  } finally { await f.close(); }
});
