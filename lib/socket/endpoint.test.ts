/** Preserve old connections while new connections follow one atomic socket rename; GN-004. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Endpoint } from './endpoint.ts';
import { connect } from '@/lib/ndjson/socket.ts';

async function listener(path: string, reply: string) {
  const clients = new Set<Socket>();
  const server = createServer(socket => { clients.add(socket); socket.on('close', () => { clients.delete(socket); }); socket.on('data', () => { socket.write(reply); }); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  return { async close() { for (const socket of clients) socket.destroy(); await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); }); } };
}

async function reply(socket: Socket): Promise<string> {
  const incoming = new Promise<string>((resolve, reject) => { socket.once('error', reject); socket.once('data', (chunk: Buffer) => { resolve(chunk.toString()); }); });
  socket.write('probe'); return incoming;
}

await test('GN-004 endpoint rename routes new connections and preserves an existing old connection', async () => {
  const root = await mkdtemp('/tmp/endpoint-'); const one = join(root, 'one'); const two = join(root, 'two'); await mkdir(one); await mkdir(two);
  const old = await listener(join(one, 'private.sock'), 'old'); const next = await listener(join(two, 'private.sock'), 'new');
  const clients: Socket[] = [];
  try {
    const endpoint = await Endpoint.open(root); assert.ok(endpoint.ok); assert.ok((await endpoint.value.repoint(join(one, 'private.sock'))).ok);
    const first = await connect(endpoint.value.path); assert.ok(first.ok); clients.push(first.value); assert.equal(await reply(first.value), 'old');
    assert.ok((await endpoint.value.repoint(join(two, 'private.sock'))).ok);
    const second = await connect(endpoint.value.path); assert.ok(second.ok); clients.push(second.value);
    assert.equal(await reply(second.value), 'new'); assert.equal(await reply(first.value), 'old');
  } finally { for (const client of clients) client.destroy(); await old.close(); await next.close(); await rm(root, { recursive: true, force: true }); }
});

await test('Generation endpoints refuse ordinary files and roots outside the target', async () => {
  const root = await mkdtemp('/tmp/endpoint-invalid-');
  try {
    const endpoint = await Endpoint.open(root); assert.ok(endpoint.ok); const file = join(root, 'regular'); await writeFile(file, 'state');
    const regular = await endpoint.value.repoint(file); assert.ok(!regular.ok); assert.equal(regular.error.code, 'outside-roots'); assert.ok(regular.error.message.includes(file));
    const outside = await endpoint.value.repoint('/tmp/not-a-private-socket'); assert.ok(!outside.ok); assert.equal(outside.error.code, 'outside-roots');
  } finally { await rm(root, { recursive: true, force: true }); }
});
