/** Load standard skill cards without accepting unchecked paths or duplicate ids; SK-001–009. */
import { parseDocument } from 'yaml';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, basename } from 'node:path';
import type { Card, Frontmatter } from '../../contracts/skills/types.ts';
import type { Schemas, Result } from '../schema/index.ts';
import { failure } from '../schema/index.ts';
import { boundedFile, resolvePath } from '../files/index.ts';

export interface LoadedSkill { card: Card; body: string }
export interface Pack { name: string; version: string; path: string }
export const defaults = { fileBytes: 1024 * 1024, skills: 10000, depth: 16, universal: 20 };

async function listing(directory: string, depth = 0): Promise<string[]> {
  if (depth > defaults.depth) throw new Error('The skill directory depth limit was exceeded.');
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('A skill directory cannot contain symlinked entries.');
    if (entry.isDirectory()) files.push(...await listing(join(directory, entry.name), depth + 1));
    else if (entry.name === 'SKILL.md') files.push(join(directory, entry.name));
    if (files.length > defaults.skills) throw new Error('The skill count limit was exceeded.');
  }
  return files.sort();
}

export async function loadPack(pack: Pack, schemas: Schemas): Promise<Result<{ skills: LoadedSkill[]; warnings: string[] }, 'invalid-args' | 'outside-roots' | 'io' | 'budget'>> {
  const skills: LoadedSkill[] = []; const warnings: string[] = [];
  try {
    const root = await realpath(join(pack.path, 'skills'));
    for (const path of await listing(root)) {
      const bound = await boundedFile(path, defaults.fileBytes); if (!bound.ok) return bound;
      const text = await readFile(path, 'utf8');
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(text);
      if (!match) return failure('invalid-args', `${path} has no standard YAML frontmatter.`);
      const document = parseDocument(match[1] ?? '');
      if (document.errors.length) return failure('invalid-args', `${path} has invalid YAML frontmatter.`);
      const front: unknown = document.toJS({ maxAliasCount: 0 });
      if (!schemas.validator<Frontmatter>('skills', 'frontmatter')(front)) return failure('invalid-args', `${path} has invalid skill frontmatter.`);
      const id = relative(root, path).split('/').slice(0, -1).join('/');
      if (front.name !== basename(join(root, id))) return failure('invalid-args', `${front.name} does not match its skill directory ${id}.`);
      if (Buffer.byteLength(front.description) > 1024) return failure('invalid-args', `${id} has a description over 1024 bytes.`);
      const body = match[2] ?? '';
      if (body.split('\n').length > 500) warnings.push(`${id} has a body over 500 lines.`);
      for (const link of body.matchAll(/\]\(([^)]+)\)/gu)) {
        const target = link[1]; if (!target || /^(https?:|#)/u.test(target)) continue;
        const found = await resolvePath(join(path, '..', target), [{ path: root, mode: 'ro', space: pack.name }]);
        if (!found.ok) return failure('outside-roots', `${id} references missing or inaccessible ${target}.`);
      }
      const card: Card = { id, pack: pack.name, version: pack.version, path, name: front.name, description: front.description,
        tags: front.metadata?.tags ?? [], related: front.metadata?.related ?? [], universal: front.metadata?.universal === 'true',
        bytes: Buffer.byteLength(text), contentHash: `sha256:${createHash('sha256').update(text).digest('hex')}`, children: [] };
      if (!schemas.validator<Card>('skills', 'card')(card)) return failure('invalid-args', `${id} is not installed at its versioned package path.`);
      skills.push({ card, body });
    }
    for (const skill of skills) skill.card.children = skills.filter(other => other.card.id.split('/').slice(0, -1).join('/') === skill.card.id).map(other => other.card.id);
    return { ok: true, value: { skills, warnings } };
  } catch { return failure('io', `${pack.name} could not load its skills safely.`); }
}

export function uniqueSkills(skills: readonly LoadedSkill[]): Result<void, 'invalid-args' | 'budget'> {
  const seen = new Map<string, string>();
  for (const skill of skills) {
    const prior = seen.get(skill.card.id);
    if (prior !== undefined) return failure('invalid-args', `${skill.card.id} is provided by both ${prior} and ${skill.card.pack}.`);
    seen.set(skill.card.id, skill.card.pack);
  }
  const universal = skills.filter(skill => skill.card.universal);
  return universal.length > defaults.universal ? failure('budget', `More than 20 universal skills exist: ${universal.map(skill => skill.card.id).join(', ')}.`) : { ok: true, value: undefined };
}
