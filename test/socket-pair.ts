/** Exercise real local transports without relying on ports or external services; KS-021. */
import { createServer, createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

export async function socketPair() {
  const root = await mkdtemp('/tmp/socket-pair-'); const path = join(root, 'socket');
  const server = createServer();
  const accepted = new Promise<Socket>(resolve => { server.once('connection', resolve); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  const client = createConnection(path); const peer = await accepted;
  return { client, peer, async close() {
    client.destroy(); peer.destroy();
    await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); });
    await rm(root, { recursive: true, force: true });
  } };
}
