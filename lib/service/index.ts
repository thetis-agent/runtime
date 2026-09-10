/** Keep inherited control separate from service requests and admission; ADR 0010, ADR 0021. */
import { authority } from '@/lib/sandbox-runner/authority.ts';
import { Peer } from '@/lib/socket/index.ts';
import { Schemas, failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import type { ConnectKernel } from '@/contracts/kernel-socket/types.ts';
import { clock } from '@/lib/events/index.ts';
import { Service, serviceLimits } from './lifecycle.ts';
import type { Connection } from './lifecycle.ts';
import { Control } from './control.ts';
export type Factory = (settings: unknown, schemas: Schemas, peer: Peer, identity: ConnectKernel) => Promise<Result<(connection: Connection) => Promise<Result<void>>>>;
export async function serve(factory: Factory, observe: (result: Result<void>) => void, capabilities: readonly string[] = [], scope: 'person' | 'deployment' = 'deployment'): Promise<Result<void>> {
  const inherited = await authority(); if (!inherited.ok) return inherited;
  const schemas = new Schemas(); await schemas.load();
  const control = new Control(
    (service, stopping) => ({ ready: service?.ready ?? false, draining: stopping }),
    failure('forbidden', 'The service does not accept this control note.')
  );
  const peer = new Peer(inherited.value.socket, schemas, clock, ['health.probe', 'profile.get', 'run.stop', 'env.updated', ...capabilities], { handlers: control.handlers, note: note => control.note(note) });
  let outcome: Result<void> = failure('io', 'The service did not initialize.');
  try {
    const connected = await peer.connect(); if (!connected.ok) return connected;
    if (connected.value.scope !== scope) return failure('forbidden', `This service requires ${scope} scope.`);
    const settings = await peer.call('profile.get', {}); if (!settings.ok) return settings;
    const handler = await factory(settings.value, schemas, peer, connected.value); if (!handler.ok) return handler;
    const service = new Service(clock, serviceLimits, 'io');
    const opened = await service.open('/endpoint/service.sock', handler.value, observe); control.ready(opened, service);
    if (!opened.ok) return opened;
    outcome = await peer.finished();
  } finally {
    if (!control.service) control.ready(failure('io', 'The service did not initialize.'));
    const stopped = await control.service?.stop(); if (stopped && !stopped.ok) outcome = stopped;
    peer.close(); await peer.finished();
  }
  return outcome;
}
