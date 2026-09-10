/** Convert Legacy's TOML skill frontmatter to the Agent Skills standard, once; findings §8. */
import { readdir, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { join, relative, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';

type Value = string | boolean | number | string[];
const LEGACY = ['name', 'brief', 'when_to_use', 'tags', 'related', 'universal', 'version', 'children', 'status', 'superseded_by'];

/** Refuses anything it does not recognize rather than guessing: a migration run once has no second
 * chance to notice that a value was silently dropped. */
export function parseToml(text: string): Result<Record<string, Value>, 'invalid-args'> {
  const fields: Record<string, Value> = {};
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([a-z_]+) = (.*)$/u.exec(line);
    if (!match?.[1] || match[2] === undefined) return failure('invalid-args', `The frontmatter line is not a simple assignment: ${line}`);
    const raw = match[2].trim();
    const quoted = /^"(.*)"$/su.exec(raw);
    if (quoted?.[1] !== undefined) fields[match[1]] = quoted[1].replaceAll('\\"', '"');
    else if (raw === 'true' || raw === 'false') fields[match[1]] = raw === 'true';
    else if (/^[0-9]+$/u.test(raw)) fields[match[1]] = Number(raw);
    else if (raw.startsWith('[') && raw.endsWith(']')) {
      const items = raw.slice(1, -1).trim();
      fields[match[1]] = items ? [...items.matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map(item => (item[1] ?? '').replaceAll('\\"', '"')) : [];
    } else return failure('invalid-args', `The frontmatter value is not a string, boolean, integer or array: ${line}`);
  }
  return { ok: true, value: fields };
}

/** Legacy's `name` is a human title and the standard's `name` is the directory, so the two swap
 * places; `children` is dropped because the loader derives it from nesting instead. */
export function standard(fields: Record<string, Value>, id: string): Result<Record<string, unknown>, 'invalid-args'> {
  const unknown = Object.keys(fields).filter(key => !LEGACY.includes(key));
  if (unknown.length) return failure('invalid-args', `${id} carries frontmatter this converter does not know: ${unknown.join(', ')}`);
  const text = (key: string): string => (typeof fields[key] === 'string' ? fields[key] : '');
  const list = (key: string): string[] => (Array.isArray(fields[key]) ? fields[key] : []);
  const description = [text('brief'), text('when_to_use')].filter(Boolean).join(' ');
  if (!description) return failure('invalid-args', `${id} has neither a brief nor a when_to_use to describe it.`);
  if (Buffer.byteLength(description) > 1024) return failure('invalid-args', `${id} has a description over 1024 bytes; shorten its brief or when_to_use.`);
  const metadata: Record<string, unknown> = {};
  if (text('name')) metadata['title'] = text('name');
  if (list('tags').length) metadata['tags'] = list('tags');
  if (list('related').length) metadata['related'] = list('related');
  // The card schema takes `universal` as the strings "true"/"false", not a boolean.
  if (fields['universal'] === true) metadata['universal'] = 'true';
  return { ok: true, value: { name: basename(id), description, ...(Object.keys(metadata).length ? { metadata } : {}) } };
}

async function files(root: string, at = root): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(at, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(at, entry.name);
    if (entry.isDirectory()) found.push(...await files(root, path)); else found.push(path);
  }
  return found.sort();
}

export async function convert(source: string, destination: string): Promise<{ converted: number; warnings: string[] }> {
  const warnings: string[] = []; let converted = 0;
  for (const path of await files(source)) {
    const target = join(destination, 'skills', relative(source, path));
    await mkdir(dirname(target), { recursive: true });
    if (basename(path) !== 'SKILL.md') { await copyFile(path, target); continue; }
    const text = await readFile(path, 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(text);
    if (!match) { warnings.push(`${path} has no frontmatter block and was skipped.`); continue; }
    const fields = parseToml(match[1] ?? '');
    if (!fields.ok) { warnings.push(`${path}: ${fields.error.message}`); continue; }
    const id = relative(source, dirname(path));
    const front = standard(fields.value, id);
    if (!front.ok) { warnings.push(front.error.message); continue; }
    const body = match[2] ?? '';
    if (body.split('\n').length > 500) warnings.push(`${id} has a body over 500 lines; the loader will warn about it.`);
    await writeFile(target, `---\n${stringify(front.value)}---\n${body}`);
    converted++;
  }
  return { converted, warnings };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [source, destination, name = 'skills-thetis', version = '1.0.0'] = process.argv.slice(2);
  if (!source || !destination) { console.error('usage: convert-skills.ts <legacy-skills-dir> <package-dir> [name] [version]'); process.exitCode = 1; }
  else {
    const result = await convert(source, destination);
    await writeFile(join(destination, 'package.json'), `${JSON.stringify({ name, version, requires: {}, provides: {}, envelope: { requires: [], provides: [], spawn: { scope: 'person', network: 'none' } }, settings: {} }, undefined, 2)}\n`);
    for (const warning of result.warnings) console.error(warning);
    console.log(`Converted ${String(result.converted)} skills into ${destination}.`);
    if (result.warnings.length) process.exitCode = 1;
  }
}
