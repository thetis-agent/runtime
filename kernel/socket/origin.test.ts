/** Exercise the own-origin act without trusting a gateway's person or origin claim; ADR 0018, KS-015–016. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { origin } from './origin.ts';
import { Identity } from '../identity/index.ts';
import { Secrets } from '../secrets/index.ts';
import { Schemas } from '../../lib/schema/index.ts';
import { actFixture, reviewer, administrator, evidence, source } from '../../test/default-act.ts';
import { post } from '../../test/origin-http.ts';

await test('KS-015 kernel origin authenticates independently, displays one code line and checks the final act', async () => {
  const fixture = await actFixture(); const schemas = new Schemas(); await schemas.load();
  const identity = new Identity({ people: [reviewer], bindings: [{ kind: 'password', id: 'reviewer', person: reviewer.id }], authorities: { password: 'designated' } }, () => 0);
  const session = identity.session('designated', 'password', 'reviewer'); assert.ok(session.ok);
  const secrets = await Secrets.open(join(fixture.root, 'sealed'), Buffer.alloc(32, 1)); assert.ok(secrets.ok);
  const server = origin({ origin: 'https://kernel.test', identity, schemas, secrets: secrets.value, act: fixture.act });
  const path = join(fixture.root, 'origin.sock'); server.listen(path); await once(server, 'listening');
  try {
    const material = evidence('candidate'); assert.ok(fixture.act.authorize(administrator, source.target, material.plan).ok); assert.ok((await fixture.act.submit(source, material.submission)).ok);
    const login = await post(path, '/session', { sessionToken: session.value.sessionToken, person: 'administrator' }); assert.equal(login.status, 200);
    const cookie = login.cookies[0]?.split(';')[0]; assert.ok(cookie); assert.match(login.cookies[0] ?? '', /HttpOnly; Secure; SameSite=Strict/u);
    assert.equal((await post(path, '/default.prepare', { digest: 'candidate', baseline: 1 }, 'https://package.test', cookie)).status, 400);
    assert.equal((await post(path, '/default.prepare', { digest: 'candidate', baseline: 1 })).status, 401);
    const prepared = await post(path, '/default.prepare', { digest: 'candidate', baseline: 1 }, undefined, cookie); assert.equal(prepared.status, 200);
    assert.equal(prepared.text.split('\n').length, 2); const code = prepared.text.trim().split(' ').at(-1); assert.ok(code);
    const secret = 'origin-only-value'; assert.equal((await post(path, '/secret.set', { scope: 'person/reviewer', name: 'key', value: secret }, undefined, cookie)).status, 200);
    assert.equal((await post(path, '/default.set', { digest: 'candidate', baseline: 1, code }, undefined, cookie)).status, 200);
    assert.equal(fixture.machine.view.current.n, 2); assert.equal((await fixture.rows()).includes(secret), false);
    assert.equal((await post(path, '/default.set', { digest: 'candidate', baseline: 1, code }, undefined, cookie)).status, 400);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => { server.close(() => { resolve(); }); }); await fixture.close(); }
});
