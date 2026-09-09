/** Respond through the real inherited control socket and script cooperative or stuck turns; GN-001, GN-003. */
import { authority } from '../../lib/sandbox-runner/authority.ts';
import { Peer } from '../../lib/socket/index.ts';
import type { Handler } from '../../lib/socket/index.ts';
import type { Method } from '../../contracts/kernel-socket/types.ts';
import { Schemas } from '../../lib/schema/index.ts';
import type { Result } from '../../lib/schema/index.ts';
import { clock } from '../../lib/events/index.ts';
import { createServer } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';

const received = await authority();
if (!received.ok) process.exitCode = 1;
else {
  const schemas = new Schemas(); await schemas.load();
  let writable = false;
  if (process.argv[4] === 'shared') {
    try { await writeFile('/work/probe-wrote', 'written'); writable = true; } catch { writable = false; }
    await writeFile(`/endpoint/${writable ? 'writable' : 'readonly'}.json`, JSON.stringify({ writable }));
  }
  if (writable && process.argv[2] === 'fail-serving') await writeFile('/state/post-commit.json', '{}');
  const endpoint = process.argv[3]; let connections = 0;
  const server = createServer(socket => {
    connections++; socket.on('close', () => { connections--; });
    socket.on('data', () => { void readFile('/revision/version', 'utf8').then(value => { socket.end(value); }, () => { socket.destroy(); }); });
  });
  if (endpoint) await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  const holds = new Map<string, () => void>(); let stopped = false;
  const handlers = new Map<Method, Handler>([
    ['health.probe', () => {
      if (writable && process.argv[2] === 'fail-serving') return Promise.resolve({ ok: true, value: { ready: false } });
      if (process.argv[2] !== 'unhealthy') return Promise.resolve({ ok: true, value: { ready: true, active: holds.size, connections } });
      if (endpoint) void peer.call('profile.get', {}).then(result => { if (!result.ok) peer.close(); });
      return new Promise(() => {});
    }],
    ['session.submit', params => {
      if (stopped || holds.size >= 2) return Promise.resolve({ ok: false, error: { code: 'switching', message: 'The fixture is draining.' } });
      const conversation = params['conversation'];
      if (typeof conversation !== 'string') throw new Error('A validated submit lost its conversation.');
      return new Promise<Result<unknown>>(resolve => { holds.set(conversation, () => { holds.delete(conversation); resolve({ ok: true, value: 'ended' }); }); });
    }]
  ]);
  const peer = new Peer(received.value.socket, schemas, clock, ['health.probe', 'session.submit', 'profile.get', 'run.stop', 'env.updated'], { handlers, async note(value) {
    if (value.note === 'run.stop') { stopped = true; holds.get('cooperative')?.(); }
    if (value.note === 'env.updated') { stopped = false; if (endpoint) await writeFile('/endpoint/update.json', JSON.stringify(value.params)); }
    return { ok: true, value: undefined };
  } });
  const connected = await peer.connect();
  if (!connected.ok) { process.exitCode = 1; }
  else { const result = await peer.finished(); if (!result.ok) process.exitCode = 1; }
}
