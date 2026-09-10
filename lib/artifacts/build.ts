/** Erase types as data in bounded trusted tooling; never evaluate an edited package; ADR 0037. */
import { readdir, realpath, stat, readFile, writeFile, cp } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import type { Artifact } from './types.ts';
import { verified } from './verify.mjs';
import { readBounded } from '../files/read-bounded.ts';
export const limits = { entries: 10000, sourceBytes: 1048576, totalBytes: 67108864, depth: 64 };
export async function sources(root: string): Promise<string[]> {
  let entries = 0; const files: string[] = [];
  async function visit(path: string, depth: number): Promise<void> {
    if (depth > limits.depth) throw new Error('The artifact source tree exceeds its depth limit.');
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (++entries > limits.entries) throw new Error('The artifact source tree exceeds its entry limit.');
      if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) throw new Error('The artifact source tree contains a non-regular entry.');
      if (entry.isDirectory()) await visit(join(path, entry.name), depth + 1);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(join(path, entry.name));
    }
  }
  if (await realpath(root) !== root) throw new Error('The artifact source root is not canonical.');
  await visit(root, 0); return files.sort();
}
function hash(value: string): string { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
export async function buildTree(source: string, destination: string, check = false, previous?: string): Promise<boolean> {
  const original = await sources(source);
  if (previous && (await realpath(previous) !== previous || previous === source || previous.startsWith(`${source}/`))) throw new Error('The previous artifacts require a separate canonical trusted tree.');
  if (source !== destination) {
    if (await realpath(dirname(destination)) !== dirname(destination) || destination.startsWith(`${source}/`)) throw new Error('The artifact destination is not a separate canonical tree.');
    await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
  }
  let fresh = true; let total = 0;
  for (const path of original) {
    const info = await stat(path);
    if (info.size > limits.sourceBytes) throw new Error('The artifact source exceeds its byte budget.');
    const target = join(destination, path.slice(source.length));
    const content = await readBounded(target, limits.sourceBytes); if (!content.ok) throw new Error(content.error.message);
    if ((total += content.value.length) > limits.totalBytes) throw new Error('The artifact sources exceed their byte budget.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(content.value);
    const output = await transformed(text, previous ? join(previous, path.slice(source.length)) : undefined);
    const metadata: Artifact = { version: 1, generator: 'node:stripTypeScriptTypes:strip', runtime: process.version, source: hash(text), output: hash(output) };
    const record = `${JSON.stringify(metadata)}\n`;
    if (check) {
      try { fresh = await readFile(`${target}.js`, 'utf8') === output && await readFile(`${target}.artifact.json`, 'utf8') === record && fresh; } catch { fresh = false; }
    } else { await writeFile(`${target}.js`, output); await writeFile(`${target}.artifact.json`, record); }
  }
  if (source !== destination && !check && (await readdir(destination)).includes('schema.json')) { const { schemaOutput } = await import('./schema-output.ts'); await schemaOutput(destination, previous); }
  return fresh;
}

async function transformed(text: string, previous?: string): Promise<string> {
  const original = previous ? await readBounded(previous, limits.sourceBytes) : undefined;
  const unchanged = original?.ok && original.value.toString('utf8') === text;
  return unchanged && previous ? verified(previous).toString('utf8') : stripTypeScriptTypes(text, { mode: 'strip' });
}
