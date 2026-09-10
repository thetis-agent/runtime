/** Prove reviewed profile delivery reaches two independent headless conversations; KS-004–009, KS-024. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, deployed, principals } from '@/test/deployment-assembly.ts';
import { edited } from '@/test/deployment-work.ts';
import { connect, send, socketFrames } from '@/lib/ndjson/socket.ts';
import { isObject } from '@/lib/schema/index.ts';
import type { Target } from '@/lib/deployment/types.ts';
import type { Target as ProcessTarget } from '@/kernel/boundary/runtime.ts';

/** Mirror the CLI socket formula documented in `docs/headless-startup.md` "Chat through the
 * person-scoped CLI socket" and "Chat through the browser": every scoped target's public socket
 * lives at `<seed-root>/targets/<SHA256-base64url(id)>/runs/public/current.sock`. */
function publicSocketSuffix(id: string): string { return join(createHash('sha256').update(id).digest('base64url'), 'runs', 'public', 'current.sock'); }

async function command(path: string, args: string[]): Promise<unknown[]> {
  const opened = await connect(path); assert.ok(opened.ok); const frames: unknown[] = [];
  try { assert.ok((await send(opened.value, { args })).ok); for await (const frame of socketFrames(opened.value)) { assert.ok(frame.ok); frames.push(frame.value); } return frames; }
  finally { opened.value.destroy(); }
}
await test('KS-009 registry pins and captured spawns assemble two isolated working headless accounts', async () => {
  const environment = await fixture();
  try {
    const { deployment, path, running } = await deployed(environment, plan => {
      const provider = plan.targets.find(target => target.id === 'provider'); assert.ok(provider);
      provider.profile['settings'] = { scripts: [...Array.from({ length: 4 }, () => [{ type: 'delta.text', text: 'Hello.' }]), [{ type: 'delta.tool_call', callId: 'write', name: 'write_path', args: JSON.stringify({ path: '/space/edited.txt', contents: 'Original.' }) }, { type: 'stop', reason: 'tool_calls' }], [{ type: 'delta.text', text: 'Done.' }]] };
    });
    for (const person of principals) {
      const web: Target | undefined = deployment.targets.find(candidate => candidate.id === `${person.id}-web`); assert.ok(web, `${person.id}-web is missing from the assembled deployment`);
      assert.equal(web.owner, person.id); assert.equal(web.scope, 'person');
      assert.equal(web.registration?.package, 'gateway-web'); assert.deepEqual(web.services, [person.id]);
    }
    const login: Target | undefined = deployment.targets.find(candidate => candidate.id === 'login'); assert.ok(login, 'login is missing from the assembled deployment');
    assert.equal(login.owner, ''); assert.equal(login.scope, 'deployment'); assert.equal(login.registration?.package, 'gateway-login'); assert.deepEqual(login.services, []);
    try {
      for (const id of [...principals.map(person => `${person.id}-web`), 'login']) {
        const endpoint = running.runtime.endpoint(id); assert.ok(endpoint.ok, JSON.stringify(endpoint));
        assert.ok(endpoint.value.endsWith(publicSocketSuffix(id)), `${id} socket ${endpoint.value} does not match the documented formula`);
      }
      const conversations: string[] = [];
      for (const person of principals) {
        const endpoint = running.runtime.endpoint(`${person.id}-cli`); assert.ok(endpoint.ok);
        const created = (await command(endpoint.value, ['new'])).at(-1); assert.ok(isObject(created) && created['ok'] === true && isObject(created['value']), JSON.stringify(created));
        const conversation = created['value']['id']; assert.ok(typeof conversation === 'string'); conversations.push(conversation);
        for (let turn = 0; turn < 2; turn++) {
          const response = await command(endpoint.value, ['send', conversation, 'Private assembled greeting']);
          const last = response.at(-1); assert.ok(isObject(last) && last['ok'] === true, JSON.stringify(response));
          assert.ok(JSON.stringify(response).includes('Hello.'));
        }
      }
      const first = principals[0]; const other = conversations[1]; assert.ok(first && other);
      assert.ok(!(await running.runtime.session(first, 'session.submit', { conversation: other, input: { text: 'cross-account', attachments: [] } })).ok);
      const rows = await readFile(join(environment.root, 'r/observed.jsonl'), 'utf8'); assert.equal(rows.split('\n').filter(row => row.includes('"kind":"turn.report"')).length, 4);
      assert.ok(!rows.includes('Private assembled greeting')); assert.ok(!rows.includes('Hello.'));
      await edited(environment.root, path, running.runtime, environment.schemas, command);
    } finally { assert.ok((await running.close()).ok); }
  } catch (error) { process.stderr.write(`${String(error)}\n`); throw error; }
  finally { await environment.close(); }
});
await test("KS-024 a person-scope gateway target may only mount its own person's environment endpoint", async () => {
  const environment = await fixture();
  try {
    const { running } = await deployed(environment);
    try {
      const bobWeb = running.runtime.current('bob-web'); assert.ok(bobWeb.ok, JSON.stringify(bobWeb));
      const probe: ProcessTarget = { ...structuredClone(bobWeb.value), id: 'bob-web-cross-owner-probe', services: ['alice'],
        revision: { ...structuredClone(bobWeb.value.revision), mounts: structuredClone(bobWeb.value.revision.mounts).map(mount => mount.source === 'service:bob' ? { ...mount, source: 'service:alice' } : mount) } };
      const refused = await running.runtime.start(probe);
      assert.ok(!refused.ok && refused.error.code === 'forbidden', JSON.stringify(refused));
    } finally { assert.ok((await running.close()).ok); }
  } finally { await environment.close(); }
});
