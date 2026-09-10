/** Start a registered shared service with inherited authority and kernel-supplied policy; ADR 0019–0020. */
import { readFile } from 'node:fs/promises';
import { authority } from '@/lib/sandbox-runner/authority.ts';
import { Peer } from '@/lib/socket/index.ts';
import { Schemas, failure, isObject } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import { clock } from '@/lib/events/index.ts';
import type { Clock } from '@/lib/events/index.ts';
import { Budgets } from './index.ts';
import type { Provider, Authority } from './index.ts';
import { BudgetCheckpoint } from './checkpoint.ts';
import { KernelAuthority } from './authority.ts';
import { listen } from './server.ts';
import type { Startup } from './types.ts';
import { Control } from '@/lib/service/control.ts';

type Factory = (settings: Record<string, unknown>, authority: Authority, budgets: Budgets, schemas: Schemas, clock: Clock, scope: 'person' | 'deployment') => Result<Provider> | Promise<Result<Provider>>;
const paths = { socket: '/endpoint/service.sock', checkpoint: '/state/budget.json' };

async function policy(peer: Peer, schemas: Schemas): Promise<Result<Startup>> {
  const supplied = await peer.call('profile.get', {}); if (!supplied.ok) return supplied;
  const raw: unknown = JSON.parse(await readFile(new URL('./schema.json', import.meta.url), 'utf8'));
  if (!isObject(raw)) throw new Error('The committed service startup schema is invalid.');
  const check = schemas.compile<Startup>({ ...raw, $id: 'thetis://internal/provider-startup/1', $ref: '#/$defs/startup' });
  return check(supplied.value) ? { ok: true, value: supplied.value } : failure('invalid-args', 'The kernel supplied invalid service policy.');
}

export async function serve(factory: Factory, observe: (result: Result<void>) => void): Promise<Result<void>> {
  const inherited = await authority(); if (!inherited.ok) return inherited;
  const schemas = new Schemas(); await schemas.load();
  const control = new Control(
    service => ({
      ready: service?.ready ?? false,
      connections: service?.connections ?? 0,
      draining: service?.paused ?? false
    }),
    { ok: true, value: undefined }
  );
  const peer = new Peer(inherited.value.socket, schemas, clock, ['health.probe', 'profile.get', 'token.whois', 'usage.report', 'run.stop', 'env.updated'], { handlers: control.handlers, note: note => control.note(note) });
  try {
    const connected = await peer.connect(); if (!connected.ok) return connected;
    const config = await policy(peer, schemas); if (!config.ok) return config;
    const checkpoint = await BudgetCheckpoint.open(paths.checkpoint, schemas); if (!checkpoint.ok) return checkpoint;
    const budgets = new Budgets(config.value.rule, Date.now, config.value.peopleLimit, checkpoint.value);
    const adapter = await factory(config.value.settings, new KernelAuthority(peer), budgets, schemas, clock, connected.value.scope); if (!adapter.ok) return adapter;
    const opened = await listen(paths.socket, adapter.value, schemas, observe); if (!opened.ok) return opened;
    control.ready({ ok: true, value: undefined }, opened.value);
    return await peer.finished();
  } finally {
    control.ready(failure('io', 'The service did not finish initialization.'));
    const stopped = await control.service?.stop(); if (stopped && !stopped.ok) observe(stopped);
    peer.close(); await peer.finished();
  }
}
