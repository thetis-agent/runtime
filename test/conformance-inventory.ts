/** Refuse an incomplete conformance inventory without claiming named tests prove every clause; ADR 0006. */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { declarations } from './conformance-names.ts';
import { packagesRoot } from '../lib/profile/packages-root.ts';
export interface Inventory { required: string[]; covered: Record<string, string[]>; missing: string[]; skipped: string[] }
const pattern = /^([A-Z]{2}-\d{3})\b/u;
async function files(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (['node_modules', '.git', '.runtime', '.registry', '.agents', '.codex', 'docs'].includes(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(path)); else if (entry.name.endsWith('.test.ts')) result.push(path);
  }
  return result;
}
export async function inventory(root: string): Promise<Inventory> {
  const required = new Set<string>(); const covered: Record<string, string[]> = {}; const skipped: string[] = [];
  const suites = (await readdir(join(root, 'docs/contracts/conformance'))).filter(name => name.endsWith('.md')).map(name => `docs/contracts/conformance/${name}`);
  for (const path of [...suites, 'docs/design/generations.md', 'docs/design/evaluator.md']) {
    const text = await readFile(join(root, path), 'utf8'); for (const match of text.matchAll(/^\|\s*([A-Z]{2}-\d{3})\s*\|/gmu)) if (match[1]) required.add(match[1]);
  }
  const registry = packagesRoot(root);
  const tests = [...await files(root), ...(registry === join(root, 'packages') ? [] : await files(registry))];
  for (const path of tests) for (const test of declarations(await readFile(path, 'utf8'), path)) {
    const id = pattern.exec(test.name)?.[1]; if (!id) continue;
    const location = `${relative(root, path)}:${String(test.line)}`;
    if (test.skipped) skipped.push(`${id} ${location}`);
    else (covered[id] ??= []).push(location);
  }
  return { required: [...required].sort(), covered, missing: [...required].filter(id => !covered[id]?.length).sort(), skipped };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await inventory(new URL('..', import.meta.url).pathname);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.missing.length || result.skipped.length) process.exitCode = 1;
}
