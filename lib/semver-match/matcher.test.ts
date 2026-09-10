/** Cover requirement prefixes, refusals and order invariance with the real matcher; proposal §3. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, envelope, gap, matches } from './index.ts';
import type { Package, Provision } from './index.ts';

const base: Package = { name: 'base', version: '1.2.0', scope: 'deployment', requires: {}, provides: {} };

await test('Every requirement prefix resolves without package-specific knowledge', () => {
  const facts: Provision[] = ['setting/path', 'secret/key', 'cap/os.linux'].map(name => ({ name, version: '1.0.0', owner: 'environment', scope: 'deployment' }));
  const names = ['service/example', 'stage/retrieve', 'mount//chat', 'contract/example', 'skills/example'];
  const provider = { ...base, provides: Object.fromEntries(names.map(name => [name, '1.0.0'])) };
  const consumer = { ...base, name: 'consumer', requires: Object.fromEntries(['base', ...names, ...facts.map(fact => fact.name)].map(name => [name, '^1'])) };
  assert.equal(resolve([consumer, provider], facts).ok, true);
  assert.equal(matches('1.2.0', '^1'), true); assert.equal(matches('2.0.0', '^1'), false);
  assert.equal(matches('invalid', '*'), false); assert.equal(matches('1.0.0', 'invalid range'), false);
});

await test('Matcher rejects absent names, incompatible scope, collisions, cycles and false machine facts', () => {
  assert.equal(resolve([{ ...base, requires: { missing: '*' } }]).ok, false);
  assert.equal(resolve([base, { ...base }]).ok, false);
  assert.equal(resolve([{ ...base, provides: { 'stage/retrieve': '1.0.0' } }, { ...base, name: 'other', provides: { 'stage/retrieve': '1.0.0' } }]).ok, false);
  assert.equal(resolve([{ ...base, requires: { other: '*' } }, { ...base, name: 'other', requires: { base: '*' } }]).ok, false);
  assert.equal(resolve([{ ...base, scope: 'person' }, { ...base, name: 'other', requires: { base: '*' } }]).ok, false);
  assert.equal(resolve([{ ...base, provides: { 'secret/fake': '1.0.0' } }]).ok, false);
});

await test('KS-009 concrete registration is bounded by its declared envelope', () => {
  assert.equal(envelope(['secret/server-a', 'cap/network.egress'], ['secret/server-*', 'cap/network.egress']).ok, true);
  assert.deepEqual(envelope(['secret/unrelated'], ['secret/server-*']), { ok: false, error: { code: 'envelope', message: 'secret/unrelated is outside the declared envelope (secret/server-*).' } });
  assert.equal(envelope(['service/axb'], ['service/a.b']).ok, false);
});

await test('The gap message has the proposal’s exact shape with registry guidance', () => {
  assert.equal(gap({ name: 'X', version: '1.2.0' }, 'service/vector-store', '>=1.9', { name: 'vectors-server', version: '0.4.0', registry: 'company' }), 'X 1.2.0 requires service/vector-store >=1.9. Nothing in this profile provides it. vectors-server 0.4.0 in the company registry does.');
});

await test('Satisfiable profiles resolve to the same set regardless of input order', () => {
  for (let seed = 1; seed <= 64; seed++) {
    const packages = Array.from({ length: 10 }, (_, i): Package => ({ ...base, name: `item-${String(i)}`, requires: i ? { [`item-${String(i - 1)}`]: '^1' } : {} }));
    const shuffled = [...packages].sort((a, b) => ((Number(a.name.slice(5)) * seed) % 11) - ((Number(b.name.slice(5)) * seed) % 11));
    assert.deepEqual(resolve(shuffled), resolve(packages));
  }
});

await test('TE-004 singleton retrieve collisions name both packages before activation', () => {
  const result = resolve([{ ...base, name: 'first', provides: { 'stage/retrieve': '1.0.0' } }, { ...base, name: 'second', provides: { 'stage/retrieve': '1.0.0' } }]);
  assert.equal(result.ok, false); assert.match(result.error.message, /first/u); assert.match(result.error.message, /second/u);
});
