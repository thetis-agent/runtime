/** Exercise private held-out queries and seeded invariance through the actual local retriever; SK-012, SK-013. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { gold } from '../packages/metrics/gold.ts';
import { retrieval } from '../packages/metrics/retrieval.ts';
import { retriever } from '../packages/retriever-local/index.ts';
import { mutate, vocabulary } from '../packages/evaluator/mutate.ts';
import { skillsFixture, skill } from './skills-fixture.ts';
import { Schemas } from '../lib/schema/index.ts';
import type { Task } from '../contracts/evaluator/types.ts';

await test('SK-012 six private held-out fixture pairs are retrieved and reported with an interval while remaining ungated', async () => {
  const skills = await skillsFixture({ astronomy: skill('astronomy'), gardening: skill('gardening'), geometry: skill('geometry') });
  const root = await mkdtemp('/tmp/private-gold-'); const schemas = new Schemas(); await schemas.load();
  try {
    const loaded = await skills.load(); assert.ok(loaded.ok); const provider = retriever(loaded.value.skills);
    const rows = Array.from({ length: 12 }, (_, index) => { const id = ['astronomy', 'gardening', 'geometry'][index % 3]; assert.ok(id); return { query: `Question ${String(index)} about ${id}.`, skills: [id] }; });
    await mkdir(join(root, 'gold')); await writeFile(join(root, 'gold/skills.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const split = await gold(root, 'private-seed', schemas); assert.ok(split.ok); assert.deepEqual(await gold(root, 'private-seed', schemas), split);
    assert.equal(split.value.heldOut.length, 6); assert.ok(split.value.visible.every(row => !split.value.heldOut.some(hidden => hidden.query === row.query)));
    const rankings = [];
    for (const row of split.value.heldOut) rankings.push({ query: row.query, skills: (await provider.retrieve({ query: row.query, k: 4, budget: 10000, model: 'scripted' })).entries.map(entry => entry.id) });
    const score = retrieval(split.value.heldOut, rankings, 'private-seed'); assert.ok(score.ok);
    assert.equal(score.value.gated, false); assert.equal(score.value.pairs, 6); assert.ok(score.value.ndcg.lower <= score.value.ndcg.mean && score.value.ndcg.mean <= score.value.ndcg.upper);
    assert.ok(score.value.ndcg.mean > 0 && score.value.ndcg.mean <= 1); assert.deepEqual(retrieval(split.value.heldOut, rankings, 'private-seed'), score);
  } finally { await skills.close(); await rm(root, { recursive: true, force: true }); }
});

await test('SK-013 seeded names and numbers preserve the actual top skill when card vocabulary is protected', async () => {
  const skills = await skillsFixture({ astronomy: skill('astronomy'), gardening: skill('gardening'), geometry: skill('geometry') });
  try {
    const loaded = await skills.load(); assert.ok(loaded.ok); const provider = retriever(loaded.value.skills); const words = vocabulary(loaded.value.skills.map(row => row.card)); assert.ok(words.ok);
    const task: Task = { id: 'sky', family: 'skill', request: 'Help Alice with 12 astronomy questions.', mutable: { names: ['Alice'], numbers: ['12'] }, requires: [], required: [], gold: { tools: [], skills: ['astronomy'] }, budget: { cost: 1, iterations: 1 }, fixture: 'fixture', checks: 'checks/run.sh' };
    const original = await provider.retrieve({ query: task.request, k: 4, budget: 10000, model: 'scripted' }); let same = 0;
    for (let index = 0; index < 32; index++) {
      const changed = mutate(task, 'private-seed', index, words.value); assert.ok(changed.ok);
      const answer = await provider.retrieve({ query: changed.value.request, k: 4, budget: 10000, model: 'scripted' });
      if (answer.entries[0]?.id === original.entries[0]?.id) same++;
    }
    assert.equal(original.entries[0]?.id, 'astronomy'); assert.ok(same / 32 >= 0.9);
  } finally { await skills.close(); }
});
