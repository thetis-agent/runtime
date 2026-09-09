/** Pin bounded and deterministic retrieval with forced activation; TE-005–008. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retriever } from './index.ts';
import { skillsFixture, skill } from '../../test/skills-fixture.ts';
import { Schemas } from '../../lib/schema/index.ts';
import type { RetrieveAnswer } from '../../contracts/skills/types.ts';

await test('TE-005 bodies fit the budget and omitted matches are named', async () => {
  const f = await skillsFixture({ query: skill('query', 'query', 'Long body '.repeat(100)) });
  try {
    const loaded = await f.load(); assert.ok(loaded.ok);
    const answer = await retriever(loaded.value.skills).retrieve({ query: 'query', k: 4, budget: 1, model: 'scripted' });
    assert.equal(answer.entries.reduce((sum, entry) => sum + Math.ceil(Buffer.byteLength(entry.body ?? '') / 4), 0), 0);
    assert.deepEqual(answer.dropped, ['query']);
  } finally { await f.close(); }
});

await test('TE-006 identical retrieval requests produce byte-identical answers', async () => {
  const f = await skillsFixture({ query: skill('query') });
  try {
    const loaded = await f.load(); assert.ok(loaded.ok); const stage = retriever(loaded.value.skills);
    const request = { query: 'query', k: 4, budget: 100, model: 'scripted' };
    assert.equal(JSON.stringify(await stage.retrieve(request)), JSON.stringify(await stage.retrieve(request)));
  } finally { await f.close(); }
});

await test('TE-007 unknown retrieval fields are ignored and the answer validates', async () => {
  const f = await skillsFixture({ query: skill('query') });
  try {
    const loaded = await f.load(); assert.ok(loaded.ok); const stage = retriever(loaded.value.skills);
    const schemas = new Schemas(); await schemas.load();
    const request = { query: 'query', k: 4, budget: 100, model: 'scripted' };
    const answer = await stage.retrieve({ ...request, future: 'ignored' });
    assert.ok(schemas.validator<RetrieveAnswer>('skills', 'retrieveAnswer')(answer));
    assert.deepEqual(answer, await stage.retrieve(request));
  } finally { await f.close(); }
});

await test('TE-008 activation keeps an unranked entry even without body budget', async () => {
  const f = await skillsFixture({ query: skill('query') });
  try {
    const loaded = await f.load(); assert.ok(loaded.ok);
    const answer = await retriever(loaded.value.skills).retrieve({ query: 'unrelated', k: 0, budget: 0, activate: ['query'], model: 'scripted' });
    assert.equal(answer.entries[0]?.id, 'query'); assert.equal(answer.entries[0].body, undefined);
  } finally { await f.close(); }
});
