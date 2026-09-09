/** Verify complete artifact bytes and hashes across arbitrary chunking; TE-016. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir, mkdir, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpillSink } from './index.ts';

await test('TE-016 spill is complete, atomically named by call id, and hashed independently of chunking', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'thetis-spill-'));
  try {
    for (let seed = 1; seed <= 32; seed++) {
      const bytes = Buffer.from(Array.from({ length: 1200 }, (_, i) => (i * seed + 17) % 256));
      const sink = new SpillSink(directory, `call-${String(seed)}`, { inlineBytes: 64, previewBytes: 16, resultBytes: 2048 });
      const width = seed * 7;
      for (let i = 0; i < bytes.length; i += width) assert.ok((await sink.write(bytes.subarray(i, i + width))).ok);
      assert.ok(!(await readdir(join(directory, 'tool-output'))).includes(`call-${String(seed)}`));
      const result = await sink.finish(); assert.ok(result.ok); assert.ok(result.value.spilled);
      assert.deepEqual(await readFile(result.value.spilled.path), bytes);
      assert.equal(result.value.spilled.hash, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
      assert.equal(result.value.spilled.bytes, bytes.length);
    }
    assert.ok((await readdir(join(directory, 'tool-output'))).every(name => !name.endsWith('.partial')));
  } finally { await rm(directory, { recursive: true }); }
});

await test('Small results stay inline, result budgets refuse, and abandoned artifacts are removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'thetis-inline-'));
  try {
    const inline = new SpillSink(directory, 'inline'); assert.ok((await inline.write(Buffer.from('hello'))).ok);
    assert.deepEqual(await inline.finish(), { ok: true, value: { text: 'hello', spilled: undefined } });
    const sink = new SpillSink(directory, 'aborted', { inlineBytes: 2, previewBytes: 1, resultBytes: 4 });
    assert.equal((await sink.write(Buffer.alloc(5))).ok, false);
    assert.ok((await sink.write(Buffer.alloc(4))).ok);
    assert.ok((await sink.abort()).ok);
    assert.deepEqual(await readdir(join(directory, 'tool-output')), []);
  } finally { await rm(directory, { recursive: true }); }
});

await test('Spill refuses a tool-output symlink into another space', async () => {
  const root = await mkdtemp(join(tmpdir(), 'thetis-spill-roots-'));
  try {
    const person = join(root, 'person'); const project = join(root, 'project');
    await mkdir(person); await mkdir(project); await symlink(project, join(person, 'tool-output'));
    const sink = new SpillSink(person, 'call', { inlineBytes: 0, previewBytes: 1, resultBytes: 4 });
    assert.deepEqual(await sink.write(Buffer.from('x')), { ok: false, error: { code: 'outside-roots', message: 'Tool output is outside the person’s space.' } });
    assert.deepEqual(await readdir(project), []);
  } finally { await rm(root, { recursive: true }); }
});
