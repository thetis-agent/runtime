/** Keep the administrator's password on a private socket and a private descriptor, and bound both answers; ADR 0048, KS-017. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { login, publicSocket } from './login.ts';
import { passwordLimits, readPassword } from './password.ts';

async function surface(path: string, answer: (body: string) => { status: number; text: string }): Promise<Server> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    request.once('end', () => {
      const replied = answer(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(replied.status, { 'content-type': 'application/json' }); response.end(replied.text);
    });
  });
  await new Promise<void>(resolve => { server.listen(path, () => { resolve(); }); });
  return server;
}

await test('a target public socket follows the published formula for its own id', () => {
  const digest = createHash('sha256').update('login').digest('base64url');
  assert.equal(publicSocket('/var/lib/z/g/g1-aabbccdd', 'login'), `/var/lib/z/g/g1-aabbccdd/targets/${digest}/runs/public/current.sock`);
});

await test('a session token comes from the login surface, and a refusal never becomes one', async () => {
  const root = await mkdtemp('/tmp/login-'); const path = join(root, 'login.sock');
  let seen = '';
  const server = await surface(path, body => {
    seen = body;
    const parsed: unknown = JSON.parse(body);
    const ok = typeof parsed === 'object' && parsed !== null && 'password' in parsed && parsed.password === 'correct horse battery';
    return ok ? { status: 200, text: JSON.stringify({ ok: true, value: { sessionToken: 'session-token' } }) } : { status: 401, text: JSON.stringify({ ok: false, error: { code: 'auth', message: 'refused' } }) };
  });
  try {
    const granted = await login(path, 'admin', 'correct horse battery');
    assert.ok(granted.ok, JSON.stringify(granted)); assert.equal(granted.value, 'session-token');
    assert.equal(seen, JSON.stringify({ id: 'admin', password: 'correct horse battery' }));
    const refused = await login(path, 'admin', 'wrong wrong wrong');
    assert.equal(refused.ok, false); assert.equal(refused.error.code, 'forbidden');
    const absent = await login(join(root, 'missing.sock'), 'admin', 'correct horse battery');
    assert.equal(absent.ok, false); assert.equal(absent.error.code, 'io');
  } finally { await new Promise<void>(resolve => { server.close(() => { resolve(); }); }); await rm(root, { recursive: true, force: true }); }
});

await test('a login surface that answers without a token, or with something other than JSON, is refused', async () => {
  const root = await mkdtemp('/tmp/login-'); const path = join(root, 'login.sock');
  const server = await surface(path, () => ({ status: 200, text: 'not json' }));
  try {
    const refused = await login(path, 'admin', 'correct horse battery');
    assert.equal(refused.ok, false); assert.equal(refused.error.code, 'io');
  } finally { await new Promise<void>(resolve => { server.close(() => { resolve(); }); }); await rm(root, { recursive: true, force: true }); }
});

await test('a password is read from a private descriptor, bounded, and refused when it is too short', async () => {
  const root = await mkdtemp('/tmp/password-');
  try {
    const path = join(root, 'secret');
    await writeFile(path, 'correct horse battery\ntrailing\n');
    const held = await open(path, 'r');
    const read = await readPassword(held.fd); await held.close();
    assert.ok(read.ok, JSON.stringify(read)); assert.equal(read.value, 'correct horse battery');
    await writeFile(path, 'short\n');
    const brief = await open(path, 'r');
    const refused = await readPassword(brief.fd); await brief.close();
    assert.equal(refused.ok, false); assert.equal(refused.error.code, 'invalid-args');
    assert.match(refused.error.message, new RegExp(String(passwordLimits.minimumLength), 'u'));
    await writeFile(path, 'x'.repeat(passwordLimits.bytes + 64));
    const oversized = await open(path, 'r');
    const bounded = await readPassword(oversized.fd); await oversized.close();
    assert.equal(bounded.ok, false); assert.equal(bounded.error.code, 'budget');
  } finally { await rm(root, { recursive: true, force: true }); }
});
