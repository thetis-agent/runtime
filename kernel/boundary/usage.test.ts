/** Preserve report provenance and caller attribution without exposing credentials; KS-012–013. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Usage, limits } from './usage.ts';
import { Identity } from '../identity/index.ts';
import { Journal } from '../log/index.ts';

async function fixture() {
  const root = await mkdtemp('/tmp/usage-'); const journal = await Journal.open(join(root, 'log.jsonl'), () => 0); assert.ok(journal.ok);
  const identity = new Identity({ people: ['alice', 'bob'].map(id => ({ id, role: 'user', projects: [], observeOthers: false })), authorities: {}, bindings: [] }, () => 0);
  const service = identity.issue({ id: 'shared', person: 'alice', scope: 'deployment', target: 'shared', generation: 1, services: [] }); assert.ok(service.ok);
  const alice = identity.issue({ id: 'alice', person: 'alice', scope: 'person', target: 'alice', generation: 1, services: ['shared'] }); assert.ok(alice.ok);
  const bob = identity.issue({ id: 'bob', person: 'bob', scope: 'person', target: 'bob', generation: 1, services: [] }); assert.ok(bob.ok);
  const run = identity.authenticate(service.value); assert.ok(run.ok); const own = identity.authenticate(alice.value); assert.ok(own.ok);
  return { usage: new Usage(identity, journal.value, () => 0, { ...limits, cost: 1 }), run: run.value, own: own.value, alice: alice.value, bob: bob.value,
    rows: () => readFile(join(root, 'log.jsonl'), 'utf8'), async close() { await journal.value.close(); await rm(root, { recursive: true, force: true }); }
  };
}

await test('KS-012 reports retain their two provenance labels and only reviewed cost reaches the mount backstop', async () => {
  const f = await fixture();
  try {
    assert.ok((await f.usage.report(f.own, { runToken: f.alice, callId: 'own', counters: { cost: 100, arbitrary: 77 } })).ok);
    assert.ok(f.usage.allowMount('alice').ok);
    assert.ok((await f.usage.report(f.run, { runToken: f.alice, callId: 'shared', counters: { cost: 1, arbitrary: 88 } })).ok);
    const refused = f.usage.allowMount('alice'); assert.ok(!refused.ok); assert.equal(refused.error.code, 'budget'); assert.ok(f.usage.allowMount('bob').ok);
    const rows = await f.rows(); assert.match(rows, /candidate-reported/u); assert.match(rows, /reviewed-reported/u);
    assert.ok(!rows.includes(f.alice)); assert.ok(!rows.includes(f.bob)); assert.ok(!rows.includes('kernel-observed'));
  } finally { await f.close(); }
});

await test('KS-013 ungranted callers and negative cost are refused; reused call ids cannot suppress accounting', async () => {
  const f = await fixture();
  try {
    const ungranted = await f.usage.report(f.run, { runToken: f.bob, callId: 'wrong', counters: { cost: 1 } }); assert.ok(!ungranted.ok); assert.equal(ungranted.error.code, 'auth');
    const other = await f.usage.report(f.own, { runToken: f.bob, callId: 'other', counters: { cost: 1 } }); assert.ok(!other.ok); assert.equal(other.error.code, 'auth');
    const invalid = await f.usage.report(f.run, { runToken: f.alice, callId: 'invalid', counters: { cost: -1 } }); assert.ok(!invalid.ok); assert.equal(invalid.error.code, 'invalid-args');
    const params = { runToken: f.alice, callId: 'one', counters: { cost: 0.6 } };
    const results = await Promise.all([f.usage.report(f.run, params), f.usage.report(f.run, params)]); assert.ok(results.every(result => result.ok));
    assert.equal((await f.rows()).trim().split('\n').length, 2); assert.ok(!f.usage.allowMount('alice').ok);
  } finally { await f.close(); }
});
