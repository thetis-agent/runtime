/** Refuse origin escalation, secret substitution and cross-scope fallback; KS-008, ADR 0009. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Secrets } from './index.ts';
import type { Principal } from '../identity/index.ts';

const person: Principal = { id: 'alice', role: 'user', projects: [], observeOthers: false };
const admin: Principal = { ...person, role: 'admin' };
const key = new Uint8Array(32).fill(71);

await test('KS-008 secret.has is boolean and package-origin writes are refused even for administrators', async () => {
  const root = await mkdtemp('/tmp/secrets-'); const opened = await Secrets.open(root, key); assert.ok(opened.ok);
  try {
    const params = { scope: 'person/alice', name: 'credential', value: 'a-person-secret' };
    assert.equal(opened.value.has(params.name, [params.scope]), false);
    const denied = await opened.value.set(admin, 'package', params); assert.ok(!denied.ok); assert.equal(denied.error.code, 'forbidden');
    assert.ok((await opened.value.set(person, 'kernel', params)).ok);
    assert.equal(opened.value.has(params.name, [params.scope]), true);
    assert.equal(opened.value.has(params.name, ['person/bob']), false);
    assert.equal((await opened.value.set(person, 'kernel', { ...params, scope: 'deployment' })).ok, false);
    assert.equal((await opened.value.deliver('unregistered', params.name)).ok, false);
    for (const file of await readdir(root)) assert.equal((await readFile(join(root, file), 'utf8')).includes(params.value), false);
    const reopened = await Secrets.open(root, key); assert.ok(reopened.ok); assert.equal(reopened.value.has(params.name, [params.scope]), true);
    assert.ok(reopened.value.register('spawn:a', params.scope, [params.name]).ok);
    const delivered = await reopened.value.deliver('spawn:a', params.name); assert.ok(delivered.ok); assert.equal(Buffer.from(delivered.value).toString(), params.value);
    reopened.value.revoke('spawn:a'); assert.equal((await reopened.value.deliver('spawn:a', params.name)).ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('Secret authentication failures never fall through to another scope', async () => {
  const root = await mkdtemp('/tmp/secrets-'); const opened = await Secrets.open(root, key); assert.ok(opened.ok);
  try {
    assert.ok((await opened.value.set(admin, 'kernel', { scope: 'person/alice', name: 'credential', value: 'personal' })).ok);
    const personal = (await readdir(root))[0]; assert.ok(personal);
    assert.ok((await opened.value.set(admin, 'kernel', { scope: 'deployment', name: 'credential', value: 'deployment' })).ok);
    await writeFile(join(root, personal), '{"nonce":"","tag":"","ciphertext":""}');
    assert.ok(opened.value.register('spawn:a', 'person/alice', ['credential']).ok);
    assert.ok(opened.value.register('spawn:d', 'deployment', ['credential']).ok);
    const failed = await opened.value.deliver('spawn:a', 'credential'); assert.ok(!failed.ok); assert.equal(failed.error.code, 'io');
    assert.match(failed.error.message, /no other scope was tried/u);
    const valid = await opened.value.deliver('spawn:d', 'credential'); assert.ok(valid.ok); assert.equal(Buffer.from(valid.value).toString(), 'deployment');
    assert.ok(opened.value.register('spawn:b', 'person/bob', ['credential']).ok);
    const absent = await opened.value.deliver('spawn:b', 'credential'); assert.ok(!absent.ok); assert.equal(absent.error.code, 'unbound');
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('Secret ciphertext is bound to its scope and name as authenticated data', async () => {
  const root = await mkdtemp('/tmp/secrets-'); const opened = await Secrets.open(root, key); assert.ok(opened.ok);
  try {
    assert.ok((await opened.value.set(admin, 'kernel', { scope: 'deployment', name: 'first', value: 'first value' })).ok);
    const first = (await readdir(root))[0]; assert.ok(first);
    assert.ok((await opened.value.set(admin, 'kernel', { scope: 'deployment', name: 'second', value: 'second value' })).ok);
    const second = (await readdir(root)).find(file => file !== first); assert.ok(second);
    await writeFile(join(root, second), await readFile(join(root, first)));
    assert.ok(opened.value.register('spawn', 'deployment', ['second']).ok);
    const result = await opened.value.deliver('spawn', 'second'); assert.ok(!result.ok); assert.equal(result.error.code, 'io');
  } finally { await rm(root, { recursive: true, force: true }); }
});
