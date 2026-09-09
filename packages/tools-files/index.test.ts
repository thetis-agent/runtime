/** Exercise actual file handlers with granted roots and a real spill sink; TE-018, TE-020–021. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stages } from './index.ts';
import { SpillSink } from '../../lib/spill/index.ts';
import type { CallRequest } from '../../contracts/turn-events/types.ts';

async function fixture() {
  const root = await mkdtemp('/tmp/files-'); const work = join(root, 'work');
  await mkdir(work); await writeFile(join(work, 'a.txt'), 'one\ntwo\nthree\n');
  await stages.init(); await stages.init();
  return {
    work,
    async call(name: string, args: Record<string, unknown>, readOnly = false) {
      const id = randomUUID(); const sink = new SpillSink(root, id);
      const request: CallRequest = { id, name, args, roots: [{ path: work, mode: readOnly ? 'ro' : 'rw', space: 'work' }], mode: { readOnly, deny: [] }, deadlineMs: 1000, budget: { resultBytes: 32768 } };
      const answer = await stages.call(request, sink); const output = await sink.finish();
      assert.ok(output.ok); return { answer, text: output.value.text };
    },
    close: () => rm(root, { recursive: true, force: true })
  };
}

await test('TE-018 read-only tools stream valid results without writing their granted root', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('read_path', { path: 'a.txt', offset: 2, limit: 1 }, true)).text, 'two\n');
    assert.match((await f.call('list_path', { path: '.' }, true)).text, /a.txt/u);
    assert.match((await f.call('find_files', { glob: '*.txt' }, true)).text, /a.txt/u);
    assert.match((await f.call('search_files', { pattern: 'two', glob: '*.txt' }, true)).text, /a.txt:2:two/u);
    assert.equal((await f.call('search_files', { pattern: 'two', glob: '*.md' }, true)).text, '');
    const denied = await f.call('write_path', { path: 'a.txt', contents: 'bad' }, true);
    assert.ok(!denied.answer.ok); assert.equal(denied.answer.error?.code, 'read-only-mode');
    assert.equal(await readFile(join(f.work, 'a.txt'), 'utf8'), 'one\ntwo\nthree\n');
  } finally { await f.close(); }
});

await test('TE-020 missing pinned handlers return gone', async () => {
  const f = await fixture();
  try { const result = await f.call('removed', {}); assert.ok(!result.answer.ok); assert.equal(result.answer.error?.code, 'gone'); }
  finally { await f.close(); }
});

await test('TE-021 repeated init preserves file handler behavior and registers nothing', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('write_path', { path: 'nested/file', contents: 'same same' })).answer.ok, true);
    const duplicate = await f.call('edit_path', { path: 'nested/file', old_text: 'same', new_text: 'new' });
    assert.ok(!duplicate.answer.ok); assert.equal(duplicate.answer.error?.code, 'not-unique');
    assert.equal((await f.call('edit_path', { path: 'nested/file', old_text: 'same', new_text: 'new', replace_all: true })).answer.ok, true);
    assert.equal(await readFile(join(f.work, 'nested/file'), 'utf8'), 'new new');
    const invalid = await f.call('edit_path', { path: 'nested/file', old_text: '', new_text: 'new' });
    assert.ok(!invalid.answer.ok); assert.equal(invalid.answer.error?.code, 'invalid-args');
    assert.equal((await f.call('delete_path', { path: 'nested', recursive: true })).answer.ok, true);
  } finally { await f.close(); }
});
