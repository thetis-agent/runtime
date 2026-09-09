/** Accept one local peer in a private directory and close the listening path; KS-001, ADR 0027. */
import { createServer } from 'node:net';
import type { Socket, Server } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { failure } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';

export const privateLimits = { endpoints: 256 };
let active = 0;
export interface PrivateEndpoint {
  path: string;
  accepted: Promise<Result<Socket, 'io'>>;
  close(): Promise<Result<void, 'io'>>;
}

function close(server: Server): Promise<Result<void, 'io'>> {
  return new Promise(resolve => { server.close(error => { resolve(error ? failure('io', 'The private endpoint could not close.') : { ok: true, value: undefined }); }); });
}

export async function privateEndpoint(root = '/tmp'): Promise<Result<PrivateEndpoint, 'io' | 'budget'>> {
  if (active >= privateLimits.endpoints) return failure('budget', 'The private endpoint pool is full.');
  active++; let directory: string;
  try { directory = await mkdtemp(join(root, 'endpoint-')); }
  catch { active--; return failure('io', 'The private endpoint directory could not be created.'); }
  const path = join(directory, 'socket'); const server = createServer({ pauseOnConnect: true }); server.maxConnections = 1;
  const accepted = Promise.withResolvers<Result<Socket, 'io'>>(); let socket: Socket | undefined;
  let closed: Promise<Result<void, 'io'>> | undefined; let disposing: Promise<Result<void, 'io'>> | undefined;
  server.on('connection', connection => {
    if (socket) { connection.destroy(); return; }
    socket = connection; closed = close(server); accepted.resolve({ ok: true, value: connection });
  });
  const opened = await new Promise<Result<void, 'io'>>(resolve => {
    server.on('error', () => { const error = failure('io', 'The private endpoint could not listen.'); accepted.resolve(error); resolve(error); });
    server.listen(path, () => { resolve({ ok: true, value: undefined }); });
  });
  if (!opened.ok) { const disposed = await dispose(); return disposed.ok ? opened : disposed; }
  return { ok: true, value: { path, accepted: accepted.promise, close: () => { disposing ??= dispose(); return disposing; } } };

  async function dispose(): Promise<Result<void, 'io'>> {
    accepted.resolve(failure('io', 'The private endpoint closed before a peer connected.')); socket?.destroy();
    closed ??= server.listening ? close(server) : Promise.resolve({ ok: true, value: undefined });
    try { const stopped = await closed; await rm(directory, { recursive: true, force: true }); return stopped; }
    catch { return failure('io', 'The private endpoint cleanup failed.'); }
    finally { active--; }
  }
}
