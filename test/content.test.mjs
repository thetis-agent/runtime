import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeContent, normalizeMessages, normalizeTurnInput, textContent, contentText, toolContent } from '../dist/src/lib/content.js';

test('legacy text normalizes while unfamiliar parts retain their complete JSON payload', () => {
  const part = { id: 'mesh', type: '@test/mesh.v1', data: { vertices: [1, 2], optional: null } };
  const input = [{ role: 'user', content: [part], extensions: { '@test/meta': { x: true } } }];
  assert.deepEqual(normalizeMessages(JSON.parse(JSON.stringify(input))), input);
  assert.deepEqual(normalizeTurnInput('hello'), [{ role: 'user', content: textContent('hello') }]);
  assert.deepEqual(normalizeMessages([{ role: 'assistant', content: 'old' }])[0].content, textContent('old'));
  assert.equal(contentText([part, ...textContent('words')]), 'words');
});

test('malformed and nonportable content is refused without dropping fields', () => {
  for (const value of [null, 42, [{ type: 'x' }], [{ type: 'x', data: NaN }], [{ type: 'x', data: { lost: undefined } }]]) {
    assert.throws(() => normalizeContent(value));
  }
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => normalizeContent([{ type: 'x', data: cycle }]));
  assert.throws(() => normalizeContent([{ id: 'same', type: 'x', data: 1 }, { id: 'same', type: 'y', data: 2 }]));
});

test('structured tool results are explicit and legacy objects remain text', () => {
  const content = [{ type: '@test/chart', data: { values: [3, 4] } }];
  assert.deepEqual(toolContent({ type: 'tool-result', content }), content);
  assert.deepEqual(toolContent({ value: 3 }), textContent('{"value":3}'));
});

test("legacy session files load canonically and unfamiliar parts survive saving", async (t) => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { SessionStore } = await import("../dist/src/lib/session-store.js");
  const dir = mkdtempSync(join(tmpdir(), "thetis-content-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const record = { id: "s_ab", user: "alice", createdAt: "now", updatedAt: "now", turns: 1, harness: {}, conversation: [{ role: "user", content: "old text" }] };
  writeFileSync(join(dir, "s_ab.json"), JSON.stringify(record));
  const store = new SessionStore(/^s_[a-f0-9]+$/);
  const loaded = store.load(dir, record.id);
  assert.deepEqual(loaded.conversation[0].content, textContent("old text"));
  const message = { id: "m", role: "assistant", content: [{ type: "@test/spatial.v9", data: { coordinate: [1, 2, 3], absent: null } }], extensions: { "@test/metadata": { value: null } } };
  loaded.conversation.push(message);
  store.save(dir, loaded);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "s_ab.json"))).conversation, loaded.conversation);
  assert.deepEqual(new SessionStore(/^s_[a-f0-9]+$/).load(dir, record.id).conversation.at(-1), message);
});

test("streams retain ordered opaque parts and reject incomplete or ambiguous lifecycles", async () => {
  const { ContentStream } = await import("../dist/src/lib/content-stream.js");
  const stream = new ContentStream();
  stream.text("before");
  const part = { id: "p", type: "@test/mesh.v1", data: null };
  stream.accept({ type: "content.start", messageId: "m", part });
  stream.accept({ type: "content.delta", messageId: "m", partId: "p", delta: { arbitrary: [1] } });
  assert.throws(() => stream.finish(), /unfinished/);
  const final = { ...part, data: { vertices: [1, 2] } };
  stream.accept({ type: "content.end", messageId: "m", part: final });
  stream.text("after");
  stream.finish();
  assert.deepEqual(stream.message(), { id: "m", role: "assistant", content: [...textContent("before"), final, ...textContent("after")] });
  assert.throws(() => stream.accept({ type: "content.delta", messageId: "m", partId: "p", delta: "late" }), /unopened/);
  assert.throws(() => stream.accept({ type: "content.start", messageId: "different", part }), /one message ID/);
});
