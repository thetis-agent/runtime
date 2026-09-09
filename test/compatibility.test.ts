/** Exercise previous-minor peers from a real git tag in both sandboxed directions; KS-003. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compatibilityArchive } from './compatibility.ts';
import { socketSuite } from './socket-suite.ts';
import { socketPair } from './socket-pair.ts';
import { SandboxRunner } from '../lib/sandbox-runner/index.ts';
import { Schemas } from '../lib/schema/index.ts';
import { Peer } from '../lib/socket/index.ts';
import { clock } from '../lib/events/index.ts';
import { Identity } from '../kernel/identity/index.ts';
import { accept } from '../kernel/socket/index.ts';
import type { Operations } from '../kernel/socket/index.ts';
import type { Method } from '../contracts/kernel-socket/types.ts';
type Operation = NonNullable<ReturnType<Operations['methods']['get']>>;

for (const direction of ['previous-client', 'previous-kernel']) await test(`KS-003 ${direction} passes the shared socket suite from its immutable tag`, async () => {
  const archived = await compatibilityArchive(); const pair = await socketPair(); const schemas = new Schemas(); await schemas.load();
  const identity = new Identity({ people: [{ id: 'alice', role: 'user', projects: [], observeOthers: false }], authorities: {}, bindings: [] }, () => 0);
  const token = identity.issue({ id: 'current', person: 'alice', scope: 'person', target: 'alice', generation: 1, services: [] }); assert.ok(token.ok);
  const operations: Operations = { methods: new Map<Method, Operation>([
    ['health.probe', (_run, params) => { if (params['fence'] === true) identity.fence('alice', 2); return Promise.resolve({ ok: true, value: { ready: true, ...params } }); }],
    ['session.cancel', () => Promise.resolve({ ok: true, value: { cancelled: true } })]
  ]), notes: [], note: () => Promise.resolve({ ok: true, value: undefined }) };
  const accepted = direction === 'previous-client' ? accept(pair.peer, token.value, identity, schemas, clock, operations) : undefined;
  const started = await new SandboxRunner('/cgroup').start({ ...archived.plan, args: [direction === 'previous-client' ? 'client' : 'kernel'], socket: pair.client, token: token.value }); assert.ok(started.ok, JSON.stringify(started));
  let diagnostics = ''; started.value.process.stderr?.on('data', (chunk: Buffer) => { diagnostics += chunk.toString(); assert.ok(diagnostics.length <= 65536); });
  let disposed = false;
  try {
    if (accepted) { const peer = await accepted; assert.ok(peer.ok, diagnostics); assert.ok((await peer.value.finished()).ok, diagnostics); }
    else {
      const peer = new Peer(pair.peer, schemas, clock, ['health.probe', 'session.cancel', 'profile.get'], { handlers: new Map(), note: () => Promise.resolve({ ok: true, value: undefined }) });
      const connected = await peer.connect(); assert.ok(connected.ok, diagnostics); assert.equal(connected.value.person, 'alice');
      try { await socketSuite(peer); } finally { peer.close(); await peer.finished(); }
    }
    assert.deepEqual(await started.value.exited, { code: 0, signal: null }, diagnostics); assert.ok((await started.value.dispose()).ok); disposed = true;
  } finally { if (!disposed) assert.ok((await started.value.stop()).ok); await pair.close(); await archived.close(); }
});
