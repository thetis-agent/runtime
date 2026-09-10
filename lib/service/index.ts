/** Keep inherited control separate from service requests and admission; ADR 0010, ADR 0021. */
import { authority } from '../sandbox-runner/authority.ts';
import { Peer } from '../socket/index.ts';
import type { Handler } from '../socket/index.ts';
import { Schemas, failure } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';
import type { Method, Note, ConnectKernel } from '../../contracts/kernel-socket/types.ts';
import { clock } from '../events/index.ts';
import { Service, serviceLimits } from './lifecycle.ts';
import type { Connection } from './lifecycle.ts';
export type Factory = (settings: unknown, schemas: Schemas, peer: Peer, identity: ConnectKernel) => Promise<Result<(connection: Connection) => Promise<Result<void>>>>;
class Control {
  service: Service | undefined;
  #pausing: Promise<Result<void>> | undefined;
  #stopping = false;
  readonly #started = Promise.withResolvers<Result<void>>();
  readonly handlers = new Map<Method, Handler>([['health.probe', async () => {
    const ready = await this.#started.promise; if (!ready.ok) return ready;
    const paused = await this.#pausing; if (paused && !paused.ok) return paused;
    return { ok: true, value: { ready: this.service?.ready ?? false, draining: this.#stopping } };
  }]]);
  ready(result: Result<void>, service?: Service): void { this.service = service; if (this.#stopping) this.#pausing = service?.pause(); this.#started.resolve(result); }
  async note(note: Note): Promise<Result<void>> {
    if (note.note === 'run.stop') { this.#stopping = true; this.#pausing ??= this.service?.pause(); }
    else if (note.note === 'env.updated' && note.params['resume'] === true && this.service) {
      const resumed = await this.service.resume(); if (!resumed.ok) return resumed;
      this.#pausing = undefined; this.#stopping = false;
    } else return failure('forbidden', 'The service does not accept this control note.');
    return { ok: true, value: undefined };
  }
}
export async function serve(factory: Factory, observe: (result: Result<void>) => void, capabilities: readonly string[] = [], scope: 'person' | 'deployment' = 'deployment'): Promise<Result<void>> {
  const inherited = await authority(); if (!inherited.ok) return inherited;
  const schemas = new Schemas(); await schemas.load(); const control = new Control();
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
