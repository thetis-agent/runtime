/** Prevent dropped, duplicated or accidentally unrestricted CI test shards; ADR 0035. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { maximumShards, shardTests, testOptions } from '@/scripts/test-options.ts';

await test('test shards cover each file exactly once and distribute adjacent files across runners', () => {
  const files = Array.from({ length: 39 }, (_, index) => `packages/p${String(index)}/index.test.ts`);
  for (let count = 1; count <= maximumShards; count++) {
    const shards = Array.from({ length: count }, (_, index) => shardTests(files.toReversed(), { index: index + 1, count }));
    assert.deepEqual(shards.flat().sort(), files.toSorted());
    assert.equal(new Set(shards.flat()).size, files.length);
    assert.ok(Math.max(...shards.map(shard => shard.length)) - Math.min(...shards.map(shard => shard.length)) <= 1);
  }
  assert.deepEqual(shardTests(['c', 'a', 'b', 'd'], { index: 1, count: 2 }), ['a', 'c']);
  assert.deepEqual(shardTests(files, undefined), files.toSorted());
});

await test('shard selection composes with coverage and focused test paths', () => {
  assert.deepEqual(testOptions(['--delegated', '--coverage', '/tmp/report', 'lib', '--shard', '2/4', 'packages']),
    { coverage: '/tmp/report', shard: { index: 2, count: 4 }, prefixes: ['lib', 'packages'] });
  assert.deepEqual(testOptions([]), { prefixes: [] });
});

await test('invalid or repeated test options fail instead of changing test coverage', () => {
  for (const shard of ['', '0/4', '5/4', '1/0', '1/17', '-1/4', '1.5/4', '1/4extra', 'Infinity/4']) {
    assert.throws(() => testOptions(['--shard', shard]), /--shard/u);
  }
  for (const args of [['--shard'], ['--shard', '1/4', '--shard', '2/4'], ['--coverage'], ['--coverage', '--shard'],
    ['--coverage', '/tmp/a', '--coverage', '/tmp/b'], ['--unknown']]) assert.throws(() => testOptions(args));
});
