/** Load the actual archived socket implementation for the compatibility matrix; KS-003. */
import assert from 'node:assert/strict';
import { authority } from '../../lib/sandbox-runner/authority.ts';
import { Peer } from '../../lib/socket/index.ts';
import { Schemas } from '../../lib/schema/index.ts';
import { clock } from '../../lib/events/index.ts';
import { Identity } from '../../kernel/identity/index.ts';
import { accept } from '../../kernel/socket/index.ts';
import type { Operations } from '../../kernel/socket/index.ts';
import { socketSuite } from '../socket-suite.ts';
import type { Method } from '../../contracts/kernel-socket/types.ts';
type Operation = NonNullable<ReturnType<Operations['methods']['get']>>;

const received = await authority(); assert.ok(received.ok);
const schemas = new Schemas(); await schemas.load();
if (process.argv[2] === 'client') {
  const peer = new Peer(received.value.socket, schemas, clock, ['health.probe', 'session.cancel', 'profile.get'], { handlers: new Map(), note: () => Promise.resolve({ ok: true, value: undefined }) });
  const connected = await peer.connect(); assert.ok(connected.ok); assert.equal(connected.value.person, 'alice');
  try { await socketSuite(peer); } finally { peer.close(); await peer.finished(); }
} else {
  const identity = new Identity({ people: [{ id: 'alice', role: 'user', projects: [], observeOthers: false }], bindings: [], authorities: {} }, () => 0);
  const token = identity.issue({ id: 'compatibility', person: 'alice', scope: 'person', target: 'alice', generation: 1, services: [] }); assert.ok(token.ok);
  const operations: Operations = { methods: new Map<Method, Operation>([
    ['health.probe', (_run, params) => { if (params['fence'] === true) identity.fence('alice', 2); return Promise.resolve({ ok: true, value: { ready: true, ...params } }); }],
    ['session.cancel', () => Promise.resolve({ ok: true, value: { cancelled: true } })]
  ]), notes: [], note: () => Promise.resolve({ ok: true, value: undefined }) };
  const accepted = await accept(received.value.socket, token.value, identity, schemas, clock, operations); assert.ok(accepted.ok);
  assert.ok((await accepted.value.finished()).ok);
}
