/** Measure an actual watched edit becoming a scoped tool implementation within two seconds; GN-001, ADR 0042. */
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { watchWork } from '@/lib/deployment/work.ts';
import { configuration } from '@/lib/deployment/index.ts';
import { start } from '@/kernel/main.ts';
import type { Runtime } from '@/kernel/boundary/runtime.ts';
import type { Schemas, Result } from '@/lib/schema/index.ts';

const maximumEditLatencyMs = 2000;

export async function edited(root: string, path: string, runtime: Runtime, schemas: Schemas, command: (path: string, args: string[]) => Promise<unknown[]>): Promise<void> {
  const config = await configuration(path, schemas); assert.ok(config.ok); const target = config.value.targets.find(target => target.id === 'alice'); assert.ok(target);
  const source = target.revision.pins['alias:/packages/tools-files@1.0.0']; assert.ok(source);
  const work = join(root, 'alice/work'); await mkdir(work); await cp(source.source, join(work, 'tools-files'), { recursive: true });
  const ready = Promise.withResolvers<Result<void>>(); let appliedMs = 0; let began = 0;
  const opened = await watchWork({ target: 'alice', root: work, cache: join(root, 'staged'), discoveryRoot: join(root, 'p'), discoveryEntry: '/opt/thetis-runtime/packages/core/work-discovery.ts' }, target, config.value, { status: (person, target) => runtime.status(person, target), switch: async (person, target, baseline) => { const before = performance.now(); const result = await runtime.switch(person, target, baseline); process.stdout.write(`switch ${String(performance.now() - before)} ms\n`); return result; } }, async path => { const before = performance.now(); const result = await start(path); process.stdout.write(`probe-start ${String(performance.now() - before)} ms\n`); return result; }, schemas, (_target, result) => { appliedMs = performance.now() - began; ready.resolve(result); });
  assert.ok(opened.ok, JSON.stringify(opened));
  try {
    const file = join(work, 'tools-files/index.ts'); const original = await readFile(file, 'utf8');
    const updated = original.replace("const contents = typeof args['contents'] === 'string' ? args['contents'] : '';", "const contents = 'Work edit is serving.';"); assert.notEqual(updated, original);
    began = performance.now(); await writeFile(file, updated); const applied = await ready.promise; assert.ok(applied.ok, JSON.stringify(applied));
    const endpoint = runtime.endpoint('alice-cli'); assert.ok(endpoint.ok); const created = await command(endpoint.value, ['new']);
    const { isObject } = await import('@/lib/schema/index.ts'); const value = created.at(-1); assert.ok(isObject(value) && isObject(value['value']) && typeof value['value']['id'] === 'string', JSON.stringify(created));
    await command(endpoint.value, ['send', value['value']['id'], 'Use the edited file tool.']);
    assert.equal(await readFile(join(root, 'alice/edited.txt'), 'utf8'), 'Work edit is serving.');
    const alice = config.value.identity.people.find(person => person.id === 'alice'); const bob = config.value.identity.people.find(person => person.id === 'bob'); assert.ok(alice && bob);
    const status = runtime.status(alice, 'alice'); const unchanged = runtime.status(bob, 'bob'); assert.ok(status.ok && unchanged.ok); assert.equal(status.value['generation'], 2); assert.equal(unchanged.value['generation'], 1);
    process.stdout.write(`${JSON.stringify({ measurement: 'work-edit-to-serve', milliseconds: appliedMs, maximum: maximumEditLatencyMs })}\n`);
    assert.ok(appliedMs <= maximumEditLatencyMs, `The work edit required ${String(appliedMs)} ms to serve.`);
  } finally { const closed = await opened.value.close(); assert.ok(closed.ok, JSON.stringify(closed)); }
}
