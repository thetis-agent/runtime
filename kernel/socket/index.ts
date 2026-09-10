/** Bind inherited endpoints to authenticated runs and recheck fences on every operation; KS-001, ADR 0019. */
import type { Socket } from 'node:net';
import type { Method, Note } from '../../contracts/kernel-socket/types.ts';
import type { Clock } from '../../lib/events/index.ts';
import type { Schemas, Result } from '../../lib/schema/index.ts';
import { Peer } from '../../lib/socket/index.ts';
import type { Handler } from '../../lib/socket/index.ts';
import type { Identity, Run } from '../identity/index.ts';

export type Operation = (run: Run, params: Record<string, unknown>) => Promise<Result<unknown>>;
export interface Operations {
  capabilities?: readonly string[];
  methods: ReadonlyMap<Method, Operation>;
  notes: readonly Note['note'][];
  note(run: Run, value: Note): Promise<Result<void>>;
}

export async function accept(
  socket: Socket, credential: string, identity: Identity, schemas: Schemas, clock: Clock, operations: Operations
): Promise<Result<Peer>> {
  const authenticated = identity.authenticate(credential, 'probe');
  if (!authenticated.ok) { socket.destroy(); return authenticated; }
  const handlers = new Map<Method, Handler>();
  for (const [method, handler] of operations.methods) handlers.set(method, params => {
    const current = identity.authenticate(credential, ['health.probe', 'profile.get', 'package.register'].includes(method) ? 'probe' : 'call');
    return current.ok ? handler(current.value, params) : Promise.resolve(current);
  });
  const peer = new Peer(socket, schemas, clock, [...handlers.keys(), ...operations.notes, ...operations.capabilities ?? []], {
    handlers, note: value => {
      const current = identity.authenticate(credential);
      return current.ok ? operations.note(current.value, value) : Promise.resolve(current);
    }
  });
  const { person, scope, generation } = authenticated.value;
  const connected = await peer.accept({ person, scope, generation });
  return connected.ok ? { ok: true, value: peer } : connected;
}
