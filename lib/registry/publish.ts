/** Publish immutable objects with compare-and-swap refs, never package scripts; ADR 0007, proposal §13.14. */
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, limits, reference } from './git.ts';
import { quota } from './quota.ts';
import { normalize } from './tree.ts';
import { snapshot } from '../snapshots/index.ts';
import { readBounded } from '../files/read-bounded.ts';
import { failure } from '../result/index.ts';
import type { Result } from '../result/index.ts';
import type { Manifest } from '../package-loader/types.ts';
import type { Pin } from './types.ts';

async function objects(repository: string, source: string, index: string): Promise<Result<string>> {
  const files = await normalize(source); if (!files.ok) return files;
  if (files.value.some(path => path.split('/').includes('checks'))) return failure('forbidden', 'The package ships checks; no package scores itself.');
  const rows: string[] = [];
  for (const path of files.value) {
    const content = await readBounded(join(source, path), limits.fileBytes); if (!content.ok) return content;
    const object = await git(repository, ['hash-object', '-w', '--stdin'], content.value); if (!object.ok) return object;
    const info = await stat(join(source, path));
    rows.push(`${(info.mode & 0o111) !== 0 ? '100755' : '100644'} ${object.value.toString('utf8').trim()}\t${path}\0`);
  }
  const staged = await git(repository, ['update-index', '-z', '--index-info'], Buffer.from(rows.join('')), { GIT_INDEX_FILE: index }); if (!staged.ok) return staged;
  const tree = await git(repository, ['write-tree'], undefined, { GIT_INDEX_FILE: index });
  return tree.ok ? { ok: true, value: tree.value.toString('utf8').trim() } : tree;
}
export async function publish(repository: string, source: string, manifest: Manifest, note: string, at: number): Promise<Result<Pin>> {
  if (!Number.isSafeInteger(at) || at < 0 || Buffer.byteLength(note) > limits.noteBytes) return failure('invalid-args', 'The release note or time is invalid.');
  const admission = await quota(repository, manifest.name, at); if (!admission.ok) return admission;
  const temporary = await mkdtemp(join(tmpdir(), 'thetis-publish-'));
  try {
    const copy = join(temporary, 'package'); const copied = await snapshot(source, copy); if (!copied.ok) return copied;
    if (JSON.stringify(JSON.parse(await readFile(join(copy, 'package.json'), 'utf8'))) !== JSON.stringify(manifest)) return failure('conflict', 'The package manifest changed during publication.');
    const tree = await objects(repository, copy, join(temporary, 'index')); if (!tree.ok) return tree;
    const hash = await snapshot(copy); if (!hash.ok) return hash;
    const message = JSON.stringify({ name: manifest.name, version: manifest.version, hash: hash.value, note, at });
    const date = `@${String(Math.floor(at / 1000))} +0000`;
    const commit = await git(repository, ['commit-tree', tree.value], Buffer.from(message), { GIT_AUTHOR_NAME: 'Thetis', GIT_AUTHOR_EMAIL: 'registry@localhost', GIT_COMMITTER_NAME: 'Thetis', GIT_COMMITTER_EMAIL: 'registry@localhost', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    if (!commit.ok) return commit;
    const id = commit.value.toString('utf8').trim();
    const commands = ['start', `create ${reference(manifest.name, manifest.version)} ${id}`, `verify refs/thetis/retired/${manifest.name}@${manifest.version} ${'0'.repeat(40)}`, admission.value, 'prepare', 'commit', ''];
    const written = await git(repository, ['update-ref', '--stdin'], Buffer.from(commands.join('\n')));
    return written.ok ? { ok: true, value: { name: manifest.name, version: manifest.version, commit: id, hash: hash.value } } : failure('conflict', 'The package version already exists or could not be published.');
  } catch { return failure('io', 'The package could not be published.'); }
  finally { await rm(temporary, { recursive: true, force: true }); }
}
