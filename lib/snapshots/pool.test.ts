/** A reused worker must preserve exact tree results and release process liveness when idle; GN-002. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { snapshot } from './index.ts';
await test('GN-002 repeated bounded worker jobs preserve failures and subsequent hashes', async () => {
  const directory = await mkdtemp('/tmp/snapshot-reuse-');
  try {
    await writeFile(`${directory}/entry`, 'immutable'); const expected = await snapshot(directory); assert.ok(expected.ok);
    for (let count = 0; count < 32; count++) {
      assert.ok(!(await snapshot(`${directory}/missing`)).ok);
      assert.deepEqual(await snapshot(directory), expected);
    }
    const requests = [snapshot(directory), snapshot(directory), snapshot(directory)]; const results = await Promise.all(requests);
    assert.deepEqual(results.slice(0, 2), [expected, expected]); assert.ok(!results[2]?.ok && results[2]?.error.code === 'budget');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

await test('GN-002 a crashed worker fails its job once and a later job receives a replacement', async () => {
  const { Workers } = await import('./pool.ts'); const pool = new Workers(new URL('../../test/fixtures/snapshot-pool-worker.ts', import.meta.url));
  for (const path of ['crash', 'exit']) {
    const failed = await pool.perform(path, undefined, 'snapshot'); assert.ok(!failed.ok && failed.error.code === 'io');
    assert.deepEqual(await pool.perform('next', undefined, 'snapshot'), { ok: true, value: 'fixture' });
  }
});
