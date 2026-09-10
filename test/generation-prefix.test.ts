/** Refresh a stored prefix once per announced generation while ordinary turns reuse its bytes; TE-009–010. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeFixture, people } from '@/test/runtime-fixture.ts';
import { isObject } from '@/lib/schema/index.ts';
import { loadCheckpoint } from '@/lib/deployment/checkpoint.ts';

await test('TE-010 a real generation update refreshes each conversation once and TE-009 ordinary turns reuse it', async () => {
  const f = await runtimeFixture(); const person = people[0]; assert.ok(person);
  try {
    const target = await f.environment(person.id); assert.ok((await f.runtime.start(target)).ok);
    const created = await f.runtime.session(person, 'session.create', { surface: 'prefix' }); assert.ok(created.ok && isObject(created.value));
    const id = created.value['id']; assert.ok(typeof id === 'string');
    const input = { conversation: id, input: { text: 'Hello', attachments: [] } };
    for (let index = 0; index < 2; index++) assert.ok((await f.runtime.session(person, 'session.submit', input)).ok);
    const runtime = target.profile['runtime']; assert.ok(isObject(runtime));
    const changed = { ...target, profile: { ...target.profile, runtime: { ...runtime, system: [{ role: 'system', source: 'core', content: [{ type: 'text', text: 'Announced changed system' }] }] } } };
    const switched = await f.runtime.switch(person, changed, 1); assert.ok(switched.ok, JSON.stringify(switched));
    for (let index = 0; index < 2; index++) assert.ok((await f.runtime.session(person, 'session.submit', input)).ok);
    const checkpoint = await loadCheckpoint(join(f.root, 'targets/checkpoints'), target.id, f.schemas); assert.ok(checkpoint.ok);
    const history = await readFile(join(checkpoint.value.state, 'conversations', id, 'conversation.jsonl'), 'utf8');
    assert.equal(history.split('\n').filter(row => row.includes('"type":"prefix"')).length, 2);
    assert.equal(history.split('\n').filter(row => row.includes('The environment changed: generation 2.')).length, 1);
    assert.match(history, /Announced changed system/u);
  } finally { await f.close(); }
});
