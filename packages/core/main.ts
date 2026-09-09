/** Keep kernel authority on the responsive monitor and all turns inside its sandbox worker; ADR 0027, KS-001. */
import { authority } from '../../lib/sandbox-runner/authority.ts';
import { Peer } from '../../lib/socket/index.ts';
import { Schemas } from '../../lib/schema/index.ts';
import type { Result } from '../../lib/schema/index.ts';
import { clock } from '../../lib/events/index.ts';
import { Environment } from './environment.ts';
import { KernelControl } from './kernel-control.ts';
import { initialize } from './startup.ts';
import { capabilities } from './protocol.ts';

async function main(): Promise<Result<void>> {
  const inherited = await authority(); if (!inherited.ok) return inherited;
  const schemas = new Schemas(); await schemas.load();
  const environment = new Environment(schemas, clock); const control = new KernelControl(environment);
  const peer = new Peer(inherited.value.socket, schemas, clock, [...capabilities, 'profile.get', 'package.register', 'notice'], { handlers: control.handlers(), note: note => control.note(note) });
  try {
    const connected = await peer.connect(); if (!connected.ok) return connected;
    const ready = await control.ready(await initialize(peer, environment, schemas, connected.value, inherited.value.token));
    if (!ready.ok) return ready;
    return await Promise.race([peer.finished(), environment.finished()]);
  } finally {
    peer.close(); const closed = await environment.close(); await peer.finished();
    if (!closed.ok) process.stderr.write(`${JSON.stringify(closed)}\n`);
  }
}

const result = await main();
if (!result.ok) { process.stderr.write(`${JSON.stringify(result)}\n`); process.exitCode = 1; }
