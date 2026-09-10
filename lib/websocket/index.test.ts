/** Reject malformed and oversized WebSocket input before it can become a gateway command; ADR 0006, KS-018. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { accept, limits } from './index.ts';
import type { RequestHandler } from './index.ts';
import { privateEndpoint } from '../socket/private.ts';
import { webClient } from '../../test/web-client.ts';
import { isObject, failure } from '../schema/index.ts';

async function fixture() {
  const endpoint = await privateEndpoint(); assert.ok(endpoint.ok);
  const opening = webClient(endpoint.value.path); const socket = await endpoint.value.accepted; assert.ok(socket.ok);
  let commands = 0;
  const handled = accept(socket.value, () => {}, channel => ({ message: value => {
    commands++; return isObject(value) ? channel.write(value) : Promise.resolve(failure('invalid-args', 'The test gateway requires an object.'));
  }, close: () => {} }));
  const client = await opening;
  return { client, commands: () => commands, handled, async close() { client.close(); await handled; assert.ok((await endpoint.value.close()).ok); } };
}
await test('WebSocket JSON errors and binary input never enter the dispatcher; unknown fields round-trip', async () => {
  const instance = await fixture();
  try {
    instance.client.socket.send('{'); assert.equal((await instance.client.next())['code'], 'invalid-args');
    instance.client.socket.send(Buffer.from('binary')); assert.equal((await instance.client.next())['code'], 'unsupported');
    assert.equal(instance.commands(), 0);
    await instance.client.send({ type: 'future', extra: { preserved: true } }); assert.deepEqual(await instance.client.next(), { type: 'future', extra: { preserved: true } });
    assert.equal(instance.commands(), 1);
  } finally { await instance.close(); }
});
await test('accept() answers a plain GET through the optional request handler without disturbing the upgrade path', async () => {
  const seen: string[] = [];
  const handler: RequestHandler = (incoming, outgoing) => {
    seen.push(incoming.url ?? '');
    outgoing.writeHead(200, { 'content-type': 'text/plain' }); outgoing.end('ok');
    return Promise.resolve({ ok: true, value: undefined });
  };

  const plain = await privateEndpoint(); assert.ok(plain.ok);
  const responding = new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = httpRequest({ socketPath: plain.value.path, method: 'GET', path: '/probe' }, incoming => {
      const chunks: Buffer[] = []; incoming.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      incoming.once('error', reject);
      incoming.once('end', () => { resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }); });
    });
    outgoing.once('error', reject); outgoing.end();
  });
  const plainSocket = await plain.value.accepted; assert.ok(plainSocket.ok);
  const plainHandled = accept(plainSocket.value, () => {}, () => ({ message: () => Promise.resolve({ ok: true, value: undefined }), close: () => {} }), handler);
  const response = await responding;
  assert.equal(response.status, 200); assert.equal(response.body, 'ok'); assert.deepEqual(seen, ['/probe']);
  plainSocket.value.destroy(); await plainHandled; assert.ok((await plain.value.close()).ok);

  const upgrading = await privateEndpoint(); assert.ok(upgrading.ok);
  const opening = webClient(upgrading.value.path);
  const upgradedSocket = await upgrading.value.accepted; assert.ok(upgradedSocket.ok);
  const upgradedHandled = accept(upgradedSocket.value, () => {}, channel => ({
    message: value => (isObject(value) ? channel.write(value) : Promise.resolve(failure('invalid-args', 'The test gateway requires an object.'))),
    close: () => {},
  }), handler);
  const client = await opening;
  await client.send({ type: 'ping' }); assert.deepEqual(await client.next(), { type: 'ping' });
  client.close(); await upgradedHandled; assert.ok((await upgrading.value.close()).ok);
});
await test('WebSocket payload and fragment limits close the connection before dispatch', async () => {
  for (const fragmented of [false, true]) {
    const instance = await fixture();
    try {
      if (fragmented) for (let index = 0; index <= limits.maxFragments; index++) instance.client.socket.send('x', { fin: false });
      else instance.client.socket.send('x'.repeat(limits.messageBytes + 1));
      const result = await instance.handled; assert.ok(!result.ok); assert.equal(result.error.code, 'protocol'); assert.equal(instance.commands(), 0);
    } finally { await instance.close(); }
  }
});
