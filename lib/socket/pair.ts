/** Create a private descriptor pair without exposing an authenticated listening path; KS-001. */
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from '../ndjson/socket.ts';
import { failure } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';

export const limits = { pairs: 256 };
let active = 0;
export interface Pair { client: Socket; peer: Socket; close(): Promise<Result<void, 'io'>> }

function close(server: Server): Promise<Result<void, 'io'>> {
  return new Promise(resolve => { server.close(error => { resolve(error ? failure('io', 'The private endpoint could not close.') : { ok: true, value: undefined }); }); });
}

async function listen(server: Server, path: string): Promise<Result<void, 'io'>> {
  return new Promise(resolve => {
    server.once('error', () => { resolve(failure('io', 'The private endpoint could not listen.')); });
    server.listen(path, () => { resolve({ ok: true, value: undefined }); });
  });
}

export async function socketPair(root = '/tmp'): Promise<Result<Pair, 'io' | 'budget'>> {
  if (active >= limits.pairs) return failure('budget', 'The private endpoint pool is full.');
  active++;
  let directory: string;
  try { directory = await mkdtemp(join(root, 'endpoint-')); }
  catch { active--; return failure('io', 'The private endpoint directory could not be created.'); }
  const server = createServer({ pauseOnConnect: true }); server.maxConnections = 1;
  const accepted = new Promise<Socket>(resolve => { server.once('connection', resolve); });
  const listening = await listen(server, join(directory, 'socket'));
  const connected = listening.ok ? await connect(join(directory, 'socket')) : listening;
  if (!connected.ok) {
    const stopped = server.listening ? await close(server) : { ok: true };
    active--; try { await rm(directory, { recursive: true, force: true }); } catch { return failure('io', 'The private endpoint cleanup failed.'); }
    return stopped.ok ? failure('io', 'The private endpoint could not connect.') : failure('io', 'The private endpoint could not close after connection failure.');
  }
  const peer = await accepted; const closed = close(server); let cleanup: Promise<Result<void, 'io'>> | undefined;
  return { ok: true, value: { client: connected.value, peer, close() {
    cleanup ??= dispose(); return cleanup;
  } } };

  async function dispose(): Promise<Result<void, 'io'>> {
    if (connected.ok) connected.value.destroy(); peer.destroy();
    try { const stopped = await closed; await rm(directory, { recursive: true, force: true }); return stopped; }
    catch { return failure('io', 'The private endpoint cleanup failed.'); }
    finally { active--; }
  }
}
