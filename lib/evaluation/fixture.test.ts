/** Keep seeded fixture mutation deterministic, private and collision refusing; EV-001, EV-002. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './fixture.ts';
import { snapshot } from '../snapshots/index.ts';

await test('EV-001 fixture mutation preserves binary data, mutates nested names and produces reproducible hashes', async () => {
  const root = await mkdtemp('/tmp/fixture-mutation-');
  try {
    const source = join(root, 'source'); await mkdir(join(source, 'Alice'), { recursive: true });
    await writeFile(join(source, 'Alice', '12.txt'), 'Alice has 12 files; Malice has 123.');
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x41]); await writeFile(join(source, 'binary'), binary);
    const hash = await snapshot(source); assert.ok(hash.ok);
    const mutation = { Alice: 'Mira', '12': '99' };
    const first = await fixture(source, hash.value, join(root, 'a'), mutation);
    const second = await fixture(source, hash.value, join(root, 'b'), mutation);
    assert.ok(first.ok); assert.deepEqual(second, first);
    assert.equal(await readFile(join(root, 'a', 'Mira', '99.txt'), 'utf8'), 'Mira has 99 files; Malice has 123.');
    assert.deepEqual(await readFile(join(root, 'a', 'binary')), binary);
    assert.equal(await readFile(join(source, 'Alice', '12.txt'), 'utf8'), 'Alice has 12 files; Malice has 123.');
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('EV-002 fixture mutation refuses conflicting names and unverified fixture contents', async () => {
  const root = await mkdtemp('/tmp/fixture-refusal-');
  try {
    const source = join(root, 'source'); await mkdir(source);
    await writeFile(join(source, 'Alice'), 'one'); await writeFile(join(source, 'Mira'), 'two');
    const hash = await snapshot(source); assert.ok(hash.ok);
    const collision = await fixture(source, hash.value, join(root, 'collision'), { Alice: 'Mira' });
    assert.ok(!collision.ok); assert.equal(collision.error.code, 'invalid-args');
    const mismatch = await fixture(source, `sha256:${'f'.repeat(64)}`, join(root, 'mismatch'), {});
    assert.ok(!mismatch.ok); assert.equal(mismatch.error.code, 'hash-mismatch');
  } finally { await rm(root, { recursive: true, force: true }); }
});
