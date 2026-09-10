/** Refuse pruning throughout conversation admission and after recovery; KS-011. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pins } from './index.ts';
import { Schemas } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
const hash = `sha256:${'a'.repeat(64)}`;

await test('KS-011 pin admission and pruning serialize so a new conversation cannot lose its installed release', async () => {
  const root = await mkdtemp('/tmp/pin-admission-'); const file = join(root, 'release'); await writeFile(file, 'verified');
  try {
    const ledger = new Pins(join(root, 'pins.json'), new Schemas()); const admitted = Promise.withResolvers<undefined>(); const created = Promise.withResolvers<Result<unknown>>();
    const conversation = ledger.create('alice', [hash, hash], () => { admitted.resolve(undefined); return created.promise; });
    await admitted.promise;
    const pruning = ledger.prune(hash, async () => { await rm(file); return { ok: true, value: undefined }; });
    created.resolve({ ok: true, value: { id: 'live' } }); assert.ok((await conversation).ok);
    assert.deepEqual(await pruning, { ok: false, error: { code: 'conflict', message: 'The release is pinned by live conversation live.' } });
    assert.equal(await readFile(file, 'utf8'), 'verified');
    assert.ok((await ledger.prune(`sha256:${'b'.repeat(64)}`, async () => { await rm(file); return { ok: true, value: undefined }; })).ok);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('KS-011 corrupt recovered pin metadata refuses removal and historical prefix hashes remain protected', async () => {
  const root = await mkdtemp('/tmp/pin-recovery-'); const path = join(root, 'pins.json');
  try {
    const ledger = new Pins(path, new Schemas());
    assert.ok((await ledger.pin({ target: 'alice', conversation: 'live', hashes: [hash] })).ok);
    const other = `sha256:${'b'.repeat(64)}`; assert.ok((await ledger.pin({ target: 'alice', conversation: 'live', hashes: [other] })).ok);
    const recovered = new Pins(path, new Schemas()); const action = () => Promise.resolve({ ok: true, value: undefined } satisfies Result<void>);
    assert.equal((await recovered.prune(hash, action)).ok, false); assert.equal((await recovered.prune(other, action)).ok, false);
    await writeFile(path, '{}'); const corrupt = await new Pins(path, new Schemas()).prune(hash, action);
    assert.ok(!corrupt.ok); assert.equal(corrupt.error.code, 'invalid-args');
  } finally { await rm(root, { recursive: true, force: true }); }
});
