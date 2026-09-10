/** Cover the pkt-line advertisement shapes, peeling and refusal codes the release workflow can produce. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTags, refsLimits } from './refs.ts';

function pkt(payload: string): string {
  return `${(payload.length + 4).toString(16).padStart(4, '0')}${payload}`;
}
const flush = '0000';
const capabilities = 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since no-progress include-tag';
const sha = (id: string): string => id.repeat(40).slice(0, 40);

function advertisement(lines: readonly string[]): Buffer {
  return Buffer.from(pkt(`# service=git-upload-pack\n`) + flush + lines.map(pkt).join('') + flush, 'utf8');
}

await test('A realistic advertisement yields only the two release tags, peeling the annotated one', () => {
  const head = sha('1'); const tagObject = sha('2'); const commit = sha('3'); const lightweight = sha('4'); const compat = sha('5'); const rc = sha('6');
  const lines = [
    `${head} refs/heads/main\0${capabilities}\n`,
    `${tagObject} refs/tags/v0.1.0\n`,
    `${commit} refs/tags/v0.1.0^{}\n`,
    `${lightweight} refs/tags/v0.1.1\n`,
    `${compat} refs/tags/compatibility/socket-v1.0.0\n`,
    `${rc} refs/tags/v1.0.0-rc.1\n`,
  ];
  const result = parseTags(advertisement(lines));
  assert.deepEqual(result, { ok: true, value: [{ tag: 'v0.1.0', commit }, { tag: 'v0.1.1', commit: lightweight }] });
});

await test('An empty repository advertising only capabilities^{} returns no tags', () => {
  const zero = '0'.repeat(40);
  const result = parseTags(advertisement([`${zero} capabilities^{}\0${capabilities}\n`]));
  assert.deepEqual(result, { ok: true, value: [] });
});

await test('A malformed packet length prefix is refused as invalid-args', () => {
  const buffer = advertisement([`${sha('7')} refs/tags/v1.0.0\n`]);
  buffer.write('zzzz', pkt(`# service=git-upload-pack\n`).length + flush.length, 'ascii');
  const result = parseTags(buffer);
  assert.equal(result.ok, false); assert.equal(result.error.code, 'invalid-args');
});

await test('A packet claiming more bytes than remain is refused as invalid-args', () => {
  const good = advertisement([`${sha('7')} refs/tags/v1.0.0\n`]);
  const truncated = good.subarray(0, good.length - 10);
  const result = parseTags(truncated);
  assert.equal(result.ok, false); assert.equal(result.error.code, 'invalid-args');
});

await test('A wrong service header is refused as invalid-args', () => {
  const buffer = Buffer.from(pkt('# service=git-receive-pack\n') + flush + flush, 'utf8');
  const result = parseTags(buffer);
  assert.equal(result.ok, false); assert.equal(result.error.code, 'invalid-args');
});

await test('Trailing bytes after the final flush packet are refused as invalid-args', () => {
  const buffer = Buffer.concat([advertisement([`${sha('7')} refs/tags/v1.0.0\n`]), Buffer.from('x')]);
  const result = parseTags(buffer);
  assert.equal(result.ok, false); assert.equal(result.error.code, 'invalid-args');
});

await test('A duplicate ref name is refused as invalid-args', () => {
  const buffer = advertisement([`${sha('7')} refs/tags/v1.0.0\n`, `${sha('8')} refs/tags/v1.0.0\n`]);
  const result = parseTags(buffer);
  assert.equal(result.ok, false); assert.equal(result.error.code, 'invalid-args');
});

await test('A ref line without a 40-lowercase-hex sha and a name is refused as invalid-args', () => {
  const buffer = advertisement(['not-a-ref-line\n']);
  const result = parseTags(buffer);
  assert.equal(result.ok, false); assert.equal(result.error.code, 'invalid-args');
});

await test('A buffer past the advertisement byte limit is refused as budget', () => {
  const result = parseTags(Buffer.alloc(refsLimits.advertisementBytes + 1));
  assert.equal(result.ok, false); assert.equal(result.error.code, 'budget');
});

await test('An advertisement past the packet-count limit is refused as budget', () => {
  const lines = Array.from({ length: refsLimits.refs + 8 }, (_, i) => `${sha('9')} refs/heads/branch-${String(i)}\n`);
  const result = parseTags(advertisement(lines));
  assert.equal(result.ok, false); assert.equal(result.error.code, 'budget');
});
