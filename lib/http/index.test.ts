/** Defend the byte-bounded read, cookie lookup and same-origin redirect guard shared by every
 * HTTP-facing package; ADR 0009, ADR 0018, ADR 0038 §4. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { bytes, body, cookie, safeRedirectPath } from './index.ts';

/** A manually-pushed `IncomingMessage`: the same class `node:http` hands every handler, driven
 * without a socket ever connecting, so this stays a stream test rather than a network one. */
function fakeRequest(chunks: readonly string[]): IncomingMessage {
  const request = new IncomingMessage(new Socket());
  for (const chunk of chunks) request.push(Buffer.from(chunk, 'utf8'));
  request.push(null);
  return request;
}

await test('bytes concatenates every chunk and refuses once the total exceeds its limit', async () => {
  const read = await bytes(fakeRequest(['ab', 'cd']), 10, 'The test body');
  assert.ok(read.ok, JSON.stringify(read)); assert.equal(read.value.toString('utf8'), 'abcd');
  const refused = await bytes(fakeRequest(['abcdefghij']), 4, 'The test body');
  assert.ok(!refused.ok); assert.equal(refused.error.code, 'frame-too-large');
});

await test('body parses the bounded bytes as JSON and refuses both an oversized and a malformed request', async () => {
  const parsed = await body(fakeRequest(['{"a":1}']), 1024, 'The test body');
  assert.deepEqual(parsed, { ok: true, value: { a: 1 } });
  const malformed = await body(fakeRequest(['not json']), 1024, 'The test body');
  assert.ok(!malformed.ok); assert.equal(malformed.error.code, 'invalid-args');
  const oversized = await body(fakeRequest(['{"a":1}']), 2, 'The test body');
  assert.ok(!oversized.ok); assert.equal(oversized.error.code, 'frame-too-large');
});

await test('cookie finds the exact name among several pairs and returns the raw, undecoded value', () => {
  assert.equal(cookie('a=1; thetis_session=abc%20def; b=2', 'thetis_session'), 'abc%20def');
  assert.equal(cookie('thetis_session=abc', 'thetis_session'), 'abc');
  assert.equal(cookie('thetis_session=', 'thetis_session'), '');
  assert.equal(cookie('a=1', 'thetis_session'), undefined);
  assert.equal(cookie(undefined, 'thetis_session'), undefined);
});

await test('safeRedirectPath accepts only a single-slash same-origin path within its byte limit', () => {
  assert.equal(safeRedirectPath('/alice/', 256), '/alice/');
  assert.equal(safeRedirectPath('//evil.example', 256), undefined);
  assert.equal(safeRedirectPath('/a\\b', 256), undefined);
  assert.equal(safeRedirectPath('not-a-path', 256), undefined);
  assert.equal(safeRedirectPath(undefined, 256), undefined);
  assert.equal(safeRedirectPath(42, 256), undefined);
  assert.equal(safeRedirectPath(`/${'a'.repeat(300)}`, 256), undefined);
});
