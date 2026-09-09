/** Exercise real pack loading, profile uniqueness and retrieval budgets; SK-001–011. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { skillsFixture, skill } from '../../../test/skills-fixture.ts';
import { uniqueSkills } from '../../../lib/skills/index.ts';
import { retriever } from '../../../packages/retriever-local/index.ts';

await test('SK-001 frontmatter validates and loading twice is deterministic', async () => {
  const fixture = await skillsFixture({ query: skill('query') });
  try { const loaded = await fixture.load(); assert.ok(loaded.ok); assert.deepEqual(await fixture.load(), loaded); }
  finally { await fixture.close(); }
});

await test('SK-002 mismatched frontmatter names identify the skill directory', async () => {
  const fixture = await skillsFixture({ query: skill('different') });
  try { const loaded = await fixture.load(); assert.ok(!loaded.ok); assert.match(loaded.error.message, /different.*query/u); }
  finally { await fixture.close(); }
});

await test('SK-003 multibyte descriptions are bounded in bytes', async () => {
  const fixture = await skillsFixture({ query: skill('query', 'λ'.repeat(600)) });
  try { const loaded = await fixture.load(); assert.ok(!loaded.ok); assert.match(loaded.error.message, /1024 bytes/u); }
  finally { await fixture.close(); }
});

await test('SK-004 long bodies warn without refusing the skill', async () => {
  const fixture = await skillsFixture({ query: skill('query', 'query', 'line\n'.repeat(501)) });
  try { const loaded = await fixture.load(); assert.ok(loaded.ok); assert.equal(loaded.value.warnings.length, 1); }
  finally { await fixture.close(); }
});

await test('SK-005 missing relative resource links are refused by name', async () => {
  const fixture = await skillsFixture({ query: skill('query', 'query', '[guide](missing.md)') });
  try { const loaded = await fixture.load(); assert.ok(!loaded.ok); assert.match(loaded.error.message, /missing.md/u); }
  finally { await fixture.close(); }
});

for (const id of ['SK-006', 'SK-007']) await test(`${id} duplicate skill ids are refused with both pack names`, async () => {
  const fixture = await skillsFixture({ query: skill('query') });
  try {
    const loaded = await fixture.load(); assert.ok(loaded.ok);
    const entry = loaded.value.skills[0]; assert.ok(entry);
    const result = uniqueSkills([entry, { ...entry, card: { ...entry.card, pack: 'second-pack' } }]);
    assert.ok(!result.ok); assert.ok(result.error.message.includes(fixture.pack.name)); assert.match(result.error.message, /second-pack/u);
  } finally { await fixture.close(); }
});

await test('SK-008 more than twenty universal skills are refused across the profile', async () => {
  const fixture = await skillsFixture({ query: skill('query', 'query', 'body', true) });
  try {
    const loaded = await fixture.load(); assert.ok(loaded.ok); const entry = loaded.value.skills[0]; assert.ok(entry);
    assert.equal(uniqueSkills(Array.from({ length: 21 }, (_, i) => ({ ...entry, card: { ...entry.card, id: `skill-${String(i)}` } }))).ok, false);
  } finally { await fixture.close(); }
});

await test('SK-009 cards hash the bytes at their versioned package path', async () => {
  const fixture = await skillsFixture({ query: skill('query') });
  try {
    const loaded = await fixture.load(); assert.ok(loaded.ok); const card = loaded.value.skills[0]?.card; assert.ok(card);
    assert.equal(card.contentHash, `sha256:${createHash('sha256').update(await readFile(card.path)).digest('hex')}`);
  } finally { await fixture.close(); }
});

await test('SK-010 universal skills remain present even when bodies cannot fit', async () => {
  const fixture = await skillsFixture({ query: skill('query', 'query', 'body', true) });
  try {
    const loaded = await fixture.load(); assert.ok(loaded.ok);
    const answer = await retriever(loaded.value.skills).retrieve({ query: 'unrelated', k: 0, budget: 0, model: 'scripted' });
    assert.equal(answer.entries[0]?.id, 'query'); assert.equal(answer.entries[0].body, undefined);
  } finally { await fixture.close(); }
});

await test('SK-011 retrieved bodies match the installed body without frontmatter', async () => {
  const fixture = await skillsFixture({ query: skill('query', 'query', 'Exact body.\n') });
  try {
    const loaded = await fixture.load(); assert.ok(loaded.ok);
    const answer = await retriever(loaded.value.skills).retrieve({ query: 'query', k: 4, budget: 1000, model: 'scripted' });
    assert.equal(answer.entries[0]?.body, 'Exact body.\n');
  } finally { await fixture.close(); }
});
