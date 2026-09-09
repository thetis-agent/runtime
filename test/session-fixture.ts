/** Supply real conversations and provider accounting to the session API; KS-004, TE-009. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Sessions } from '../packages/core/sessions.ts';
import type { Runtime } from '../packages/core/sessions.ts';
import { Schemas } from '../lib/schema/index.ts';
import { ManualClock } from '../lib/events/index.ts';
import { providerFixture } from './provider-fixture.ts';
import type { Envelope } from '../contracts/turn-events/types.ts';
import type { Vendor } from '../lib/provider/engine.ts';
import { ProviderEngine } from '../lib/provider/engine.ts';

export async function sessionFixture(vendor?: Vendor) {
  const root = await mkdtemp('/tmp/sessions-'); const schemas = new Schemas(); await schemas.load(); const clock = new ManualClock();
  const provider = providerFixture(); const events: Envelope[] = [];
  const options = { model: 'scripted', provider: 'instance', token: provider.token, space: root, system: [{ role: 'system', source: 'core', content: [{ type: 'text', text: 'Stored head. '.repeat(4096) }] }], roots: [{ path: root, mode: 'rw', space: 'person' }], mode: { readOnly: false, deny: [] }, refresh: ['ignored extension'] } satisfies Runtime['options'] & { refresh: string[] };
  const runtime: Runtime = { options, schemas, clock, provider: vendor ? new ProviderEngine(vendor, provider.authority, provider.budgets) : provider.provider, stages: [{ source: 'faux-gateway', gateway: true, observe: event => { events.push(event); } }] };
  const state = join(root, 'conversations'); await mkdir(state);
  const opened = await Sessions.open(state, runtime); assert.ok(opened.ok);
  return { root, state, runtime, sessions: opened.value, events, provider, async close() { await opened.value.pause(); await rm(root, { recursive: true, force: true }); } };
}
