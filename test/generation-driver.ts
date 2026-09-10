/** Drive the real generation table with a controlled clock and durable observations; GN-001–007. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Generations } from '@/kernel/generations/index.ts';
import type { Input, Generation } from '@/kernel/generations/index.ts';
import { Journal } from '@/kernel/log/index.ts';
import { ManualClock } from '@/lib/events/index.ts';

export const initial: Generation = { n: 1, pins: { release: 'sha256:old' }, stateSnapshot: '', prefixRenderer: '1', at: 0 };
export const candidate: Generation = { ...initial, pins: { release: 'sha256:new' } };
export const forward: readonly Input[] = [
  { event: 'switch', reason: 'requested', candidate, baseline: 1, authorized: true },
  { event: 'drained', reason: 'all ended', active: 0 },
  { event: 'snapshot', reason: 'verified', snapshot: 'sha256:state', snapshotVerified: true },
  { event: 'applied', reason: 'verified', pinsVerified: true, migrationsPassed: true, formatValid: true },
  { event: 'healthy', reason: 'answered', probed: true, clientCompatible: true },
  { event: 'repointed', reason: 'renamed', atomic: true },
  { event: 'closed', reason: 'connections closed', connections: 0 }
];

export async function generationDriver() {
  const root = await mkdtemp('/tmp/generation-'); const path = join(root, 'observations.jsonl');
  const clock = new ManualClock(); const opened = await Journal.open(path, () => clock.now()); assert.ok(opened.ok);
  const machine = new Generations('person:a', initial, opened.value, () => clock.now());
  return {
    root, clock, machine,
    async move(input: Input) { const result = await machine.transition(input); assert.ok(result.ok, JSON.stringify(result)); return result.value; },
    async advance(count: number) { for (const input of forward.slice(0, count)) assert.ok((await machine.transition(input)).ok); },
    rows: () => readFile(path, 'utf8'),
    async close() { await opened.value.close(); await rm(root, { recursive: true, force: true }); }
  };
}
