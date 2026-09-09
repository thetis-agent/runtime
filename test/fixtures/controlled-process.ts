/** Respond through the real inherited control socket and script cooperative or stuck turns; GN-001, GN-003. */
import { authority } from '../../lib/sandbox-runner/authority.ts';
import { Peer } from '../../lib/socket/index.ts';
import type { Handler } from '../../lib/socket/index.ts';
import type { Method } from '../../contracts/kernel-socket/types.ts';
import { Schemas } from '../../lib/schema/index.ts';
import type { Result } from '../../lib/schema/index.ts';
import { clock } from '../../lib/events/index.ts';

const received = await authority();
if (!received.ok) process.exitCode = 1;
else {
  const schemas = new Schemas(); await schemas.load();
  const holds = new Map<string, () => void>(); let stopped = false;
  const handlers = new Map<Method, Handler>([
    ['health.probe', () => process.argv[2] === 'unhealthy' ? new Promise(() => {}) : Promise.resolve({ ok: true, value: { ready: true, active: holds.size } })],
    ['session.submit', params => {
      if (stopped || holds.size >= 2) return Promise.resolve({ ok: false, error: { code: 'switching', message: 'The fixture is draining.' } });
      const conversation = params['conversation'];
      if (typeof conversation !== 'string') throw new Error('A validated submit lost its conversation.');
      return new Promise<Result<unknown>>(resolve => { holds.set(conversation, () => { holds.delete(conversation); resolve({ ok: true, value: 'ended' }); }); });
    }]
  ]);
  const peer = new Peer(received.value.socket, schemas, clock, ['health.probe', 'session.submit', 'run.stop'], { handlers, note(value) {
    if (value.note === 'run.stop') { stopped = true; holds.get('cooperative')?.(); }
    return Promise.resolve({ ok: true, value: undefined });
  } });
  const connected = await peer.connect();
  if (!connected.ok) { process.exitCode = 1; }
  else { const result = await peer.finished(); if (!result.ok) process.exitCode = 1; }
}
