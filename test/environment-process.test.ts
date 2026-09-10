/** Chat through two actual sandboxed environments without exposing provider content to kernel control; KS-004, ADR 0019. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceFixture } from '@/test/provider-service.ts';
import { environmentProcess } from '@/test/environment-process.ts';
import { isObject } from '@/lib/schema/index.ts';

await test('KS-004 two real environment processes chat with inherited identities and isolated conversation state', async () => {
  const shared = await serviceFixture(1); assert.ok((await shared.process.probe()).ok);
  const alice = await environmentProcess(shared, 'alice'); const bob = await environmentProcess(shared, 'bob');
  try {
    const ids: string[] = [];
    for (const environment of [alice, bob]) {
      assert.ok((await environment.process.probe()).ok);
      const created = await environment.process.invoke('session.create', { surface: 'faux-gateway' });
      assert.ok(created.ok && isObject(created.value), JSON.stringify(created)); const id = created.value['id']; assert.ok(typeof id === 'string'); ids.push(id);
      for (let turn = 0; turn < 2; turn++) {
        const response = await environment.process.invoke('session.submit', { conversation: id, input: { text: 'Hello', attachments: [] } });
        assert.ok(response.ok && isObject(response.value), JSON.stringify(response)); assert.deepEqual(Object.keys(response.value).sort(), ['conversation', 'head']);
      }
      const rows = await readFile(join(environment.root, 'state/conversations', id, 'conversation.jsonl'), 'utf8');
      assert.ok(rows.includes('Hello.')); assert.ok(!rows.includes(environment.token));
      assert.deepEqual(await readdir(join(environment.root, 'state/conversations')), [id]);
    }
    const a = ids[0]; const b = ids[1]; assert.ok(a && b);
    const cross = await alice.process.invoke('session.submit', { conversation: b, input: { text: 'Other account', attachments: [] } }); assert.ok(!cross.ok); assert.equal(cross.error.code, 'not-found');
    const wrongPerson = await bob.process.invoke('session.list', { person: 'alice' }); assert.ok(!wrongPerson.ok); assert.equal(wrongPerson.error.code, 'forbidden');
    const reports = (await shared.rows()).split('\n').filter(row => row.includes('usage.report'));
    assert.equal(reports.length, 4); assert.ok(reports.some(row => row.includes('"person":"alice"'))); assert.ok(reports.some(row => row.includes('"person":"bob"')));
    for (const environment of [alice, bob]) {
      const log = await environment.rows(); assert.ok(!log.includes('Hello')); assert.ok(!log.includes(environment.token));
      const expected = environment === alice ? 3 : 2;
      const diagnostic = log.split('\n').filter(row => row.includes('"kind":"turn.report"'));
      assert.equal(diagnostic.length, 2); assert.ok(diagnostic.every(row => row.includes('"provenance":"candidate-reported"')));
      assert.equal(log.split('\n').filter(row => row.includes('"kind":"turn.start"')).length, expected);
      assert.equal(log.split('\n').filter(row => row.includes('"kind":"turn.end"')).length, expected);
    }
  } finally { await alice.close(); await bob.close(); await shared.close(); }
});
