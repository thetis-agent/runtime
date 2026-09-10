/** Keep claims labelled and preserve recovery capacity under concurrent writers; ADR 0014, KS-020. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Journal, limits } from '@/kernel/log/index.ts';

await test('Journal serializes observed and reported halves without relabelling claims', async () => {
  const root = await mkdtemp('/tmp/log-'); const path = join(root, 'turns');
  const journal = await Journal.open(path, () => 0); assert.ok(journal.ok);
  try {
    const results = await Promise.all([
      journal.value.observed('a', 'turn', { turn: 'one' }),
      journal.value.reported('a', 'turn', { turn: 'one', provenance: 'kernel-observed' }),
      journal.value.reported('a', 'usage', { cost: 0 }, true)
    ]);
    assert.ok(results.every(result => result.ok));
    const rows = (await readFile(path, 'utf8')).trim().split('\n');
    assert.match(rows[0] ?? '', /^\{"provenance":"kernel-observed"/u);
    assert.match(rows[1] ?? '', /^\{"provenance":"candidate-reported"/u);
    assert.match(rows[2] ?? '', /^\{"provenance":"reviewed-reported"/u);
  } finally { await journal.value.close(); await rm(root, { recursive: true, force: true }); }
});

await test('Journal bounds rows and leaves reserved capacity for observed recovery', async () => {
  const root = await mkdtemp('/tmp/log-');
  const journal = await Journal.open(join(root, 'turns'), () => 0, { ...limits, bytes: 1024, recoveryBytes: 1024, rowBytes: 512 }); assert.ok(journal.ok);
  try {
    assert.equal((await journal.value.reported('a', 'turn', {})).ok, false);
    assert.equal((await journal.value.observed('a', 'failed', {}, true)).ok, true);
    assert.equal((await journal.value.observed('a', 'failed', { text: 'x'.repeat(512) }, true)).ok, false);
  } finally { await journal.value.close(); await rm(root, { recursive: true, force: true }); }
});
