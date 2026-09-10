/** Preserve immutable profile assembly and defer subsequent work edits to the next switch; GN-001–002. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { materialize } from './index.ts';
import { WorkQueue } from './work.ts';
import type { Layer } from './types.ts';
import type { Work } from './work.ts';
import { snapshot } from '@/lib/snapshots/index.ts';
import { Schemas } from '@/lib/schema/index.ts';
import { ManualClock } from '@/lib/events/index.ts';

await test('GN-002 composite layout verifies selected trees and exposes exact cache aliases', async () => {
  const root = await mkdtemp('/tmp/profile-case-'); const source = join(root, 'source'); await mkdir(source);
  try {
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'example', version: '1.0.0', type: 'module' }));
    await writeFile(join(source, 'index.ts'), 'export const stages = {};');
    const hash = await snapshot(source); assert.ok(hash.ok);
    const layer = { kind: 'packages', directory: 'example', source, pin: { name: 'example', version: '1.0.0', commit: 'a'.repeat(40), hash: hash.value } } satisfies Layer;
    const installed = await materialize([layer], join(root, 'installed'), new Schemas()); assert.ok(installed.ok);
    assert.equal(installed.value.mount, '/opt/thetis-runtime'); assert.equal(installed.value.aliases[0]?.mount, '/packages/example@1.0.0');
    assert.deepEqual(await snapshot(installed.value.source), { ok: true, value: installed.value.hash });
    assert.equal(await readFile(join(installed.value.source, 'packages/example/index.ts'), 'utf8'), 'export const stages = {};');
    assert.equal((await materialize([{ ...layer, pin: { ...layer.pin, hash: `sha256:${'0'.repeat(64)}` } }], join(root, 'bad'), new Schemas())).ok, false);
    assert.equal((await materialize([layer, layer], join(root, 'duplicate'), new Schemas())).ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
await test('GN-001 work edits during a pending switch stage into the following revision', async () => {
  const root = await mkdtemp('/tmp/work-case-'); const work = join(root, 'work'); await mkdir(join(work, 'example'), { recursive: true });
  const clock = new ManualClock(); const first = Promise.withResolvers<readonly Work[]>(); const second = Promise.withResolvers<readonly Work[]>(); const release = Promise.withResolvers<undefined>();
  let calls = 0;
  const queue = new WorkQueue(work, join(root, 'cache'), clock, async changes => { calls++; if (calls === 1) { first.resolve(changes); await release.promise; } else second.resolve(changes); return { ok: true, value: undefined }; });
  try {
    await writeFile(join(work, 'example/index.ts'), 'first'); assert.ok(queue.notify('example').ok); clock.advance(50);
    const staged = await first.promise; assert.equal(await readFile(join(staged[0]?.source ?? '', 'index.ts'), 'utf8'), 'first');
    await writeFile(join(work, 'example/index.ts'), 'second'); assert.ok(queue.notify('example').ok); assert.equal(queue.pending, 1);
    assert.equal(calls, 1); release.resolve(undefined); await setImmediate(); clock.advance(50);
    const next = await second.promise; assert.equal(await readFile(join(next[0]?.source ?? '', 'index.ts'), 'utf8'), 'second');
    assert.notEqual(staged[0]?.hash, next[0]?.hash); assert.ok((await queue.settled()).ok);
  } finally { release.resolve(undefined); await queue.close(); await rm(root, { recursive: true, force: true }); }
});
await test('GN-002 work staging refuses symlink escapes and bounded queue overflow', async () => {
  const root = await mkdtemp('/tmp/work-refusal-'); const work = join(root, 'work'); await mkdir(work);
  const clock = new ManualClock(); const queue = new WorkQueue(work, join(root, 'cache'), clock, () => Promise.resolve({ ok: true, value: undefined }), { debounceMs: 50, pending: 1 });
  try {
    await symlink('/usr', join(work, 'escape')); assert.ok(queue.notify('escape').ok);
    assert.equal(queue.notify('another').ok, false); assert.equal(queue.notify('../outside').ok, false); clock.advance(50);
    const result = await queue.settled(); assert.equal(result.ok, false); assert.equal(result.error.code, 'outside-roots');
  } finally { await queue.close(); await rm(root, { recursive: true, force: true }); }
});
