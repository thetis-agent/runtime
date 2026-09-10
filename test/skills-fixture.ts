/** Install skill fixtures at their contract paths inside the test sandbox; SK-009. */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { Schemas } from '@/lib/schema/index.ts';
import { loadPack } from '@/lib/skills/index.ts';

export async function skillsFixture(files: Readonly<Record<string, string>>) {
  const name = `fixture-${randomUUID()}`;
  const path = `/packages/${name}@1.0.0`;
  await mkdir(join(path, 'skills'), { recursive: true });
  for (const [id, text] of Object.entries(files)) {
    const file = join(path, 'skills', id, 'SKILL.md'); await mkdir(dirname(file), { recursive: true }); await writeFile(file, text);
  }
  const schemas = new Schemas(); await schemas.load();
  const pack = { name, version: '1.0.0', path };
  return { pack, schemas, load: () => loadPack(pack, schemas), close: () => rm(path, { recursive: true }) };
}

export function skill(name: string, description = 'database query', body = 'Use transactions.', universal = false): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\nmetadata:\n  universal: "${String(universal)}"\n---\n${body}`;
}
