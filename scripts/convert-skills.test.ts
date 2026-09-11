/** The converter's output is only worth anything if lib/skills can load it; findings §8. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Schemas } from '@/lib/schema/index.ts';
import { loadPack } from '@/lib/skills/index.ts';
import { parseToml, standard, convert } from './convert-skills.ts';

const legacy = (name: string, extra = '') => `---\nname = "${name}"\nbrief = "A brief."\nwhen_to_use = "When asked."\ntags = ["one", "two"]\nversion = 2\n${extra}---\nBody with a [link](./notes.md).\n`;

await test('a simple assignment of every legacy value kind parses, and anything else refuses', () => {
  const parsed = parseToml('name = "A title"\nuniversal = true\nversion = 2\ntags = ["a", "b"]\nrelated = []\n# comment\n');
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, { name: 'A title', universal: true, version: 2, tags: ['a', 'b'], related: [] });
  const table = parseToml('[section]\n');
  assert.ok(!table.ok);
  assert.match(table.error.message, /not a simple assignment/u);
  const date = parseToml('written = 2026-09-10\n');
  assert.ok(!date.ok);
  assert.match(date.error.message, /not a string, boolean, integer or array/u);
});

await test('legacy name becomes the title and the directory becomes the name', () => {
  const parsed = parseToml('name = "Careful surgery"\nbrief = "Cut once."\nwhen_to_use = "Always."\nuniversal = true\ntags = ["a"]\nchildren = "none"\n');
  assert.ok(parsed.ok);
  const front = standard(parsed.value, 'thetis/careful-surgery');
  assert.ok(front.ok);
  assert.deepEqual(front.value, { name: 'careful-surgery', description: 'Cut once. Always.', metadata: { title: 'Careful surgery', tags: ['a'], universal: 'true' } });
});

await test('frontmatter the converter does not know is refused rather than dropped', () => {
  const front = standard({ brief: 'A brief.', when_to_use: 'When asked.', embedding_model: 'bge-m3' }, 'alpha');
  assert.ok(!front.ok);
  assert.match(front.error.message, /alpha carries frontmatter this converter does not know: embedding_model/u);
});

await test('a converted pack loads through lib/skills, nesting and sibling resources included', async () => {
  const source = join('/packages', `legacy-${randomUUID()}`);
  const alias = `converted-${randomUUID()}@3.1.0`;
  const destination = join('/packages', alias);
  try {
    for (const id of ['alpha', 'alpha/beta']) {
      await mkdir(join(source, id), { recursive: true });
      await writeFile(join(source, id, 'SKILL.md'), legacy(`Title of ${id}`, id === 'alpha' ? 'universal = true\n' : ''));
      await writeFile(join(source, id, 'notes.md'), '# notes\n');
    }
    const result = await convert(source, destination);
    assert.deepEqual(result, { converted: 2, warnings: [] });
    const schemas = new Schemas(); await schemas.load();
    const loaded = await loadPack({ name: alias.slice(0, -6), version: '3.1.0', path: destination }, schemas);
    assert.ok(loaded.ok, loaded.ok ? '' : loaded.error.message);
    assert.deepEqual(loaded.value.skills.map(item => item.card.id), ['alpha', 'alpha/beta']);
    const [parent, child] = loaded.value.skills;
    assert.ok(parent); assert.ok(child);
    assert.deepEqual(parent.card.children, ['alpha/beta']);
    assert.equal(parent.card.universal, true);
    assert.equal(child.card.universal, false);
    assert.equal(parent.card.description, 'A brief. When asked.');
    // The sibling resource has to travel with the skill or the body's link would refuse the pack.
    assert.equal(await readFile(join(destination, 'skills', 'alpha', 'notes.md'), 'utf8'), '# notes\n');
  } finally { for (const path of [source, destination]) await rm(path, { recursive: true, force: true }); }
});
