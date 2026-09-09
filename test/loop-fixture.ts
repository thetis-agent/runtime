/** Exercise complete turns with the real loop, dispatcher and conversation store; TE-001. */
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Schemas } from '../lib/schema/index.ts';
import { ManualClock } from '../lib/events/index.ts';
import { Loop } from '../packages/core/index.ts';
import type { Options } from '../packages/core/index.ts';
import { Conversation } from '../packages/core/conversation.ts';
import { providerFixture } from './provider-fixture.ts';
import type { Stage } from '../lib/events/stages.ts';
import type { Envelope } from '../contracts/turn-events/types.ts';
import type { ResponseEvent } from '../contracts/provider/types.ts';

export async function loopFixture(handlers: Stage[] = [], scripts: readonly (readonly ResponseEvent[])[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'thetis-loop-'));
  const schemas = new Schemas(); await schemas.load();
  const conversation = new Conversation(join(directory, 'conversation.jsonl'), schemas);
  const loaded = await conversation.load(); if (!loaded.ok) throw new Error(loaded.error.message);
  const provider = providerFixture(scripts);
  const events: Envelope[] = [];
  const loop = new Loop([...handlers, { source: 'test-surface', observe: event => { events.push(event); } }], schemas, new ManualClock(), provider.provider, conversation);
  const options: Options = {
    conversation: 'conversation', model: 'scripted', provider: 'instance', token: provider.token, space: directory,
    system: [{ role: 'system', source: 'core', content: [{ type: 'text', text: 'Stable prompt. '.repeat(4000) }] }],
    roots: [{ path: directory, mode: 'rw', space: 'person' }], mode: { readOnly: false, deny: [] }
  };
  return { loop, conversation, events, options, provider, directory, close: () => rm(directory, { recursive: true }) };
}
