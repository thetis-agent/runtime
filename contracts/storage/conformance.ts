/** Exercise real storage providers with contract-owned cases, without replacing their I/O; ST-001–007. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink, link, mkdir, rename, chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { StorageProvider, Result } from './index.ts';

const limits = { entries: 2, valueBytes: 16, bytes: 20 };
const bytes = (value: string): Uint8Array => Buffer.from(value);
function code(result: Result<unknown>, expected: string): void {
  assert.ok(!result.ok, JSON.stringify(result)); assert.equal(result.error.code, expected);
}

export async function persistence(provider: StorageProvider): Promise<void> {
  const root = await mkdtemp('/tmp/storage-');
  try {
    await writeFile(join(root, 'legacy.sealed'), bytes('existing envelope'), { mode: 0o600 });
    const settings = { ...limits, valueBytes: 32, bytes: 64 };
    const opened = await provider.open(root, settings); assert.ok(opened.ok);
    assert.equal(opened.value.has('legacy.sealed'), true);
    assert.deepEqual(await opened.value.get('legacy.sealed'), { ok: true, value: bytes('existing envelope') });
    assert.ok((await opened.value.put('object', bytes('first'))).ok);
    assert.ok((await opened.value.put('object', bytes('replacement'))).ok);
    const reopened = await provider.open(root, settings); assert.ok(reopened.ok);
    assert.deepEqual(await reopened.value.get('object'), { ok: true, value: bytes('replacement') });
    assert.equal((await stat(join(root, 'object'))).mode & 0o777, 0o600);
    code(await reopened.value.get('missing'), 'not-found');
  } finally { await rm(root, { recursive: true, force: true }); }
}

export async function bounds(provider: StorageProvider): Promise<void> {
  const root = await mkdtemp('/tmp/storage-');
  try {
    const opened = await provider.open(root, limits); assert.ok(opened.ok); const store = opened.value;
    for (const key of ['', '..', '../escape', '/absolute', 'a/b', 'a\0b', 'x'.repeat(129)]) {
      code(await store.put(key, bytes('x')), 'invalid-args'); code(await store.get(key), 'invalid-args'); assert.equal(store.has(key), false);
    }
    code(await store.put('too-big', new Uint8Array(17)), 'budget');
    assert.ok((await store.put('one', new Uint8Array(16))).ok);
    code(await store.put('two', new Uint8Array(5)), 'budget');
    assert.ok((await store.put('one', bytes('x'))).ok);
    assert.ok((await store.put('two', new Uint8Array(16))).ok);
    code(await store.put('three', bytes('x')), 'budget');
    code(await provider.open(root, { ...limits, entries: 1 }), 'budget');
    code(await provider.open(root, { ...limits, bytes: 16 }), 'budget');
    code(await provider.open(root, { ...limits, valueBytes: 15 }), 'budget');
    await writeFile(join(root, 'two'), new Uint8Array(17));
    code(await store.get('two'), 'budget');
  } finally { await rm(root, { recursive: true, force: true }); }
}

export async function paths(provider: StorageProvider): Promise<void> {
  const root = await mkdtemp('/tmp/storage-');
  try {
    const path = join(root, 'store'); const outside = join(root, 'outside'); await writeFile(outside, 'outside');
    const opened = await provider.open(path, limits); assert.ok(opened.ok);
    await symlink(outside, join(path, 'link'));
    code(await opened.value.put('link', bytes('overwrite')), 'io');
    code(await provider.open(path, limits), 'io');
    await rm(join(path, 'link')); await link(outside, join(path, 'link'));
    code(await opened.value.put('link', bytes('overwrite')), 'io'); code(await provider.open(path, limits), 'io');
    await rm(join(path, 'link'));
    assert.ok((await opened.value.put('known', bytes('safe'))).ok);
    await rm(join(path, 'known')); await symlink(outside, join(path, 'known'));
    code(await opened.value.get('known'), 'io'); assert.equal(await readFile(outside, 'utf8'), 'outside');
    await rm(join(path, 'known')); await mkdir(join(path, 'directory'));
    code(await provider.open(path, limits), 'io');
    await rename(path, join(root, 'previous')); await mkdir(path);
    code(await opened.value.put('new', bytes('x')), 'io');
    await rm(path, { recursive: true }); await symlink(join(root, 'previous'), path);
    code(await provider.open(path, limits), 'io'); code(await opened.value.get('known'), 'io');
    const before = await readdir(join(root, 'previous'));
    code(await provider.open(join(path, 'nested'), limits), 'io');
    assert.deepEqual(await readdir(join(root, 'previous')), before);
  } finally { await rm(root, { recursive: true, force: true }); }
}

export async function concurrent(provider: StorageProvider): Promise<void> {
  const root = await mkdtemp('/tmp/storage-');
  try {
    const settings = { ...limits }; const opening = provider.open(root, settings);
    settings.entries = 100; settings.valueBytes = 100; settings.bytes = 100;
    const opened = await opening; assert.ok(opened.ok);
    const original = bytes('original'); const first = opened.value.put('one', original); original.fill(0);
    code(await opened.value.put('two', bytes('parallel')), 'budget');
    assert.ok((await first).ok);
    const reading = opened.value.get('one');
    code(await opened.value.get('one'), 'budget'); code(await opened.value.put('two', bytes('overlap')), 'budget');
    assert.deepEqual(await reading, { ok: true, value: bytes('original') });
    assert.ok((await opened.value.put('two', bytes('x'))).ok);
    code(await opened.value.put('three', bytes('x')), 'budget');
    code(await opened.value.put('one', new Uint8Array(17)), 'budget');
  } finally { await rm(root, { recursive: true, force: true }); }
}

export async function failures(provider: StorageProvider): Promise<void> {
  const root = await mkdtemp('/tmp/storage-');
  try {
    const opened = await provider.open(root, limits); assert.ok(opened.ok);
    assert.ok((await opened.value.put('one', bytes('before'))).ok);
    await chmod(root, 0o500);
    code(await opened.value.put('one', bytes('after')), 'io');
    await chmod(root, 0o700);
    code(await opened.value.put('one', bytes('retry')), 'io'); code(await opened.value.get('one'), 'io');
    assert.equal(await readFile(join(root, 'one'), 'utf8'), 'before');
    const reopened = await provider.open(root, limits); assert.ok(reopened.ok);
    assert.ok((await reopened.value.put('one', bytes('retry'))).ok);
  } finally { await chmod(root, 0o700); await rm(root, { recursive: true, force: true }); }
}

export async function journal(provider: StorageProvider): Promise<void> {
  const root = await mkdtemp('/tmp/storage-');
  try {
    const path = join(root, 'journal'); const settings = { rowBytes: 8, queuedRows: 2 };
    const opening = provider.journal(path, settings); settings.queuedRows = 100; settings.rowBytes = 100;
    const opened = await opening; assert.ok(opened.ok);
    const log = opened.value; const value = Uint8Array.from(bytes('one\n')); const first = log.append(value, 12); value.fill(0);
    structuredClone(value.buffer, { transfer: [value.buffer] });
    const second = log.append(bytes('two\n'), 12); code(await log.append(bytes('three\n'), 12), 'budget');
    assert.ok((await first).ok); assert.ok((await second).ok);
    code(await log.append(bytes('big-frame'), 100), 'budget');
    code(await log.append(bytes('three\n'), 12), 'budget'); code(await log.append(bytes('x'), NaN), 'budget');
    const closing = log.close(); code(await log.append(bytes('x'), 12), 'io'); await closing; await log.close();
    assert.equal(await readFile(path, 'utf8'), 'one\ntwo\n');
    const reopened = await provider.journal(path, { rowBytes: 8, queuedRows: 2 }); assert.ok(reopened.ok);
    try { code(await reopened.value.append(bytes('three\n'), 12), 'budget'); assert.ok((await reopened.value.append(bytes('end\n'), 12)).ok); }
    finally { await reopened.value.close(); }
    assert.equal(await readFile(path, 'utf8'), 'one\ntwo\nend\n');
    await symlink(path, join(root, 'link')); code(await provider.journal(join(root, 'link'), { rowBytes: 8, queuedRows: 2 }), 'io');
    await link(path, join(root, 'hard')); code(await provider.journal(path, { rowBytes: 8, queuedRows: 2 }), 'io');
  } finally { await rm(root, { recursive: true, force: true }); }
}

export async function configuration(provider: StorageProvider): Promise<void> {
  const root = await mkdtemp('/tmp/storage-');
  try {
    for (const settings of [{ ...limits, entries: 0 }, { ...limits, entries: 10001 }, { ...limits, bytes: NaN }, { ...limits, bytes: 1073741825 }, { ...limits, valueBytes: 1.5 }, { ...limits, valueBytes: 16777217 }]) {
      code(await provider.open(root, settings), 'invalid-args');
    }
    assert.ok((await provider.open(root, { ...limits, future: 'ignored' })).ok);
    code(await provider.journal(join(root, 'journal'), { rowBytes: 0, queuedRows: 2 }), 'io');
    code(await provider.journal(join(root, 'journal'), { rowBytes: 8, queuedRows: Infinity }), 'io');
  } finally { await rm(root, { recursive: true, force: true }); }
}
