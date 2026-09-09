/** Start a registered shared service with inherited authority and kernel-supplied policy; ADR 0019–0020. */
import { readFile } from 'node:fs/promises';
import { authority } from '../sandbox-runner/authority.ts';
import { Peer } from '../socket/index.ts';
import type { Handler } from '../socket/index.ts';
import type { Method, Note } from '../../contracts/kernel-socket/types.ts';
import { Schemas, failure, isObject } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';
import { clock } from '../events/index.ts';
import type { Clock } from '../events/index.ts';
import { Budgets } from './index.ts';
import type { Provider, Authority } from './index.ts';
import { BudgetCheckpoint } from './checkpoint.ts';
import { KernelAuthority } from './authority.ts';
import { listen } from './server.ts';
import type { Service } from './lifecycle.ts';
import type { Startup } from './types.ts';

type Factory = (settings: Record<string, unknown>, authority: Authority, budgets: Budgets, schemas: Schemas, clock: Clock) => Result<Provider> | Promise<Result<Provider>>;
const paths = { socket: '/endpoint/service.sock', checkpoint: '/state/budget.json' };

class Control {
  service: Service | undefined;
  readonly #started = Promise.withResolvers<Result<void>>();
  #stopRequested = false;
  #drained: Promise<Result<void>> | undefined;
  readonly handlers = new Map<Method, Handler>([['health.probe', async () => {
    const started = await this.#started.promise; if (!started.ok) return started;
    const drained = await this.#drained; if (drained && !drained.ok) return drained;
    return { ok: true, value: { ready: this.service?.ready ?? false, connections: this.service?.connections ?? 0, draining: this.service?.paused ?? false } };
  }]]);

  started(result: Result<void>): void { this.#started.resolve(result); }
  attach(service: Service): void {
    this.service = service;
    if (this.#stopRequested) this.#drained = service.pause();
    this.started({ ok: true, value: undefined });
  }

  async note(note: Note): Promise<Result<void>> {
    if (note.note === 'run.stop') { this.#stopRequested = true; this.#drained ??= this.service?.pause(); }
    if (note.note === 'env.updated' && note.params['resume'] === true && this.service) {
      const resumed = await this.service.resume(); if (!resumed.ok) return resumed;
      this.#drained = undefined;
      this.#stopRequested = false;
    }
    return { ok: true, value: undefined };
  }
}

async function policy(peer: Peer, schemas: Schemas): Promise<Result<Startup>> {
  const supplied = await peer.call('profile.get', {}); if (!supplied.ok) return supplied;
  const raw: unknown = JSON.parse(await readFile(new URL('./schema.json', import.meta.url), 'utf8'));
  if (!isObject(raw)) throw new Error('The committed service startup schema is invalid.');
  const check = schemas.compile<Startup>({ ...raw, $id: 'thetis://internal/provider-startup/1', $ref: '#/$defs/startup' });
  return check(supplied.value) ? { ok: true, value: supplied.value } : failure('invalid-args', 'The kernel supplied invalid service policy.');
}

export async function serve(factory: Factory, observe: (result: Result<void>) => void): Promise<Result<void>> {
  const inherited = await authority(); if (!inherited.ok) return inherited;
  const schemas = new Schemas(); await schemas.load(); const control = new Control();
  const peer = new Peer(inherited.value.socket, schemas, clock, ['health.probe', 'profile.get', 'token.whois', 'usage.report', 'run.stop', 'env.updated'], { handlers: control.handlers, note: note => control.note(note) });
  try {
    const connected = await peer.connect(); if (!connected.ok) return connected;
    if (connected.value.scope !== 'deployment') return failure('auth', 'This registered service requires deployment scope.');
    const config = await policy(peer, schemas); if (!config.ok) return config;
    const checkpoint = await BudgetCheckpoint.open(paths.checkpoint, schemas); if (!checkpoint.ok) return checkpoint;
    const budgets = new Budgets(config.value.rule, Date.now, config.value.peopleLimit, checkpoint.value);
    const adapter = await factory(config.value.settings, new KernelAuthority(peer), budgets, schemas, clock); if (!adapter.ok) return adapter;
    const opened = await listen(paths.socket, adapter.value, schemas, observe); if (!opened.ok) return opened;
    control.attach(opened.value);
    return await peer.finished();
  } finally {
    control.started(failure('io', 'The service did not finish initialization.'));
    const stopped = await control.service?.stop(); if (stopped && !stopped.ok) observe(stopped);
    peer.close(); await peer.finished();
  }
}
