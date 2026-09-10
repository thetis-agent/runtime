/** Provision password hashes and real identity bindings at external test edges; KS-006–007. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Identity } from '../kernel/identity/index.ts';
import { Schemas } from '../lib/schema/index.ts';
import { ManualClock } from '../lib/events/index.ts';
import { credential } from '../packages/gateway-login/password.ts';
export { Identity } from '../kernel/identity/index.ts';
export async function loginFixture() {
  const root = await mkdtemp('/tmp/password-authority-'); const schemas = new Schemas(); await schemas.load(); const clock = new ManualClock();
  const hashed = await credential('external-alice', 'Alice password'); assert.ok(hashed.ok);
  const path = join(root, 'accounts.json'); await writeFile(path, JSON.stringify({ version: 1, accounts: [hashed.value] }));
  const identity = new Identity({ people: [{ id: 'alice', role: 'user', projects: [], observeOthers: false }], bindings: [{ kind: 'password', id: 'external-alice', person: 'alice' }], authorities: { password: 'login' } }, () => clock.now());
  return { root, schemas, clock, path, identity, async close() { await rm(root, { recursive: true, force: true }); } };
}
