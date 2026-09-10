/** Keep immutable recovery pins and live state while collecting expired workspaces; GN-002, implementation note 0046. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { activeRuns, retireRuns } from './retention.ts';
import { retainPin, pinLimits } from './pins.ts';
import { snapshot } from './index.ts';

await test('GN-002 workspace collection preserves live state, the public endpoint and legacy pin anchors', async () => {
  const root = await mkdtemp('/tmp/retention-');
  try {
    for (const path of ['public', 'live/state', 'old/state', 'old/endpoint', 'old/pins/package', 'unused/state']) await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, 'old/pins/package/index.ts'), 'retained source');
    await writeFile(join(root, 'live/state/value'), 'live state');
    assert.deepEqual(await activeRuns(root), { ok: true, value: 3 });
    assert.ok((await retireRuns(root, [join(root, 'live/state')])).ok);
    assert.deepEqual((await readdir(root)).sort(), ['live', 'old', 'public']);
    assert.deepEqual(await readdir(join(root, 'old')), ['pins']);
    assert.equal(await readFile(join(root, 'old/pins/package/index.ts'), 'utf8'), 'retained source');
    assert.equal(await readFile(join(root, 'live/state/value'), 'utf8'), 'live state');
    assert.deepEqual(await activeRuns(root), { ok: true, value: 1 });
    await symlink(join(root, 'live'), join(root, 'forged'));
    const refused = await retireRuns(root, []); assert.ok(!refused.ok); assert.equal(refused.error.code, 'outside-roots');
    assert.equal(await readFile(join(root, 'live/state/value'), 'utf8'), 'live state');
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('GN-002 retained pins deduplicate and remain usable at capacity while changed or forged content is refused', async () => {
  const root = await mkdtemp('/tmp/retained-pins-'); const maximum = pinLimits.retained; pinLimits.retained = 1;
  try {
    const source = join(root, 'source'); const pool = join(root, 'pins'); await mkdir(source); await writeFile(join(source, 'entry'), 'first');
    const hash = await snapshot(source); assert.ok(hash.ok);
    const first = await retainPin(pool, source, hash.value, false); assert.ok(first.ok);
    assert.deepEqual(await retainPin(pool, source, hash.value, false), first);
    await writeFile(join(source, 'entry'), 'second'); const changed = await snapshot(source); assert.ok(changed.ok);
    const full = await retainPin(pool, source, changed.value, false); assert.ok(!full.ok); assert.equal(full.error.code, 'budget');
    assert.equal(await readFile(join(first.value, 'entry'), 'utf8'), 'first');
    await writeFile(join(first.value, 'entry'), 'tampered');
    const refused = await retainPin(pool, source, hash.value, false); assert.ok(!refused.ok); assert.equal(refused.error.code, 'hash-mismatch');
    assert.equal((await readdir(pool)).length, 1);
  } finally { pinLimits.retained = maximum; await rm(root, { recursive: true, force: true }); }
});
