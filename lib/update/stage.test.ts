/** Read release tags from a real reference advertisement and promote staged bytes only after every check passes; ADR 0048, GN-002. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Schemas } from '@/lib/schema/index.ts';
import { git } from '@/lib/registry/git.ts';
import { buildRelease } from '@/test/release-fixture.ts';
import { stage, tags } from './stage.ts';

const identity = { GIT_AUTHOR_NAME: 'release', GIT_AUTHOR_EMAIL: 'release@thetis-agent', GIT_AUTHOR_DATE: '@0 +0000',
  GIT_COMMITTER_NAME: 'release', GIT_COMMITTER_EMAIL: 'release@thetis-agent', GIT_COMMITTER_DATE: '@0 +0000' };

/** `lib/registry/git.ts` runs every command against a git directory, so the fixture uses plumbing rather than a worktree. */
async function remote(root: string): Promise<{ path: string; commit: string }> {
  const path = join(root, 'runtime.git');
  const text = (result: Awaited<ReturnType<typeof git>>): string => { assert.ok(result.ok, JSON.stringify(result)); return result.value.toString('utf8').trim(); };
  assert.ok((await git(path, ['init', '--bare', '--quiet'])).ok);
  const blob = text(await git(path, ['hash-object', '-w', '--stdin'], Buffer.from('release remote\n')));
  const tree = text(await git(path, ['mktree'], Buffer.from(`100644 blob ${blob}\tREADME.md\n`)));
  const commit = text(await git(path, ['commit-tree', tree], Buffer.from('first\n'), identity));
  const annotated = text(await git(path, ['mktag'], Buffer.from(`object ${commit}\ntype commit\ntag v0.1.0\ntagger release <release@thetis-agent> 0 +0000\n\nv0.1.0\n`)));
  for (const [reference, target] of [['refs/heads/main', commit], ['refs/tags/v0.1.0', annotated], ['refs/tags/v0.1.1', commit],
    ['refs/tags/compatibility/socket-v1.0.0', commit], ['refs/tags/v0.2.0-rc.1', commit]] satisfies [string, string][]) {
    assert.ok((await git(path, ['update-ref', reference, target])).ok);
  }
  return { path, commit };
}

await test('the release advertisement yields only release tags, with an annotated tag peeled to its commit', async () => {
  const root = await mkdtemp('/tmp/refs-');
  try {
    const built = await remote(root);
    const listed = await tags(`file://${built.path}`); assert.ok(listed.ok, JSON.stringify(listed));
    assert.deepEqual(listed.value.map(tag => tag.tag), ['v0.1.0']);
    for (const tag of listed.value) assert.equal(tag.commit, built.commit);
    const absent = await tags(`file://${join(root, 'missing')}`); assert.equal(absent.ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('GN-002 a release is staged beside the serving one, refuses a second staging of the same version, and leaves nothing behind when a byte differs', async () => {
  const root = await mkdtemp('/assembly/s'); const schemas = new Schemas(); await schemas.load();
  try {
    const releases = join(root, 'releases'); await mkdir(releases, { recursive: true });
    const published = join(root, 'published'); await mkdir(published, { recursive: true });
    const fixture = await buildRelease(join(published, 'v0.1.0'), { tag: 'v0.1.0' });
    const options = { allowedSigners: fixture.allowedSigners, signer: fixture.signer, releases };
    const tag = { tag: fixture.tag, commit: fixture.commit };
    const staged = await stage(`file://${published}`, tag, options, schemas);
    assert.ok(staged.ok, JSON.stringify(staged));
    assert.equal(staged.value.path, join(releases, 'v0.1.0'));
    assert.equal(staged.value.verified.provenance.runtime.commit, fixture.commit);
    assert.ok((await readdir(releases)).every(name => !name.startsWith('.staging.')));
    assert.ok((await readdir(staged.value.path)).includes('kernel'), 'The staged release keeps its extracted tree.');
    const again = await stage(`file://${published}`, tag, options, schemas);
    assert.ok(again.ok, JSON.stringify(again));
    await writeFile(join(staged.value.path, 'lib/update/package.json'), '{}');
    const tampered = await stage(`file://${published}`, tag, options, schemas);
    assert.equal(tampered.ok, false); assert.equal(tampered.error.code, 'hash-mismatch');
    await rm(staged.value.path, { recursive: true, force: true });
    const asset = join(fixture.dir, 'registry.json');
    await writeFile(asset, (await readFile(asset, 'utf8')).replace(/[0-9]/u, digit => digit === '9' ? '8' : String(Number(digit) + 1)));
    const refused = await stage(`file://${published}`, tag, options, schemas);
    assert.equal(refused.ok, false); assert.equal(refused.error.code, 'hash-mismatch');
    assert.deepEqual(await readdir(releases), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('an in-progress staging directory and a traversal tag never count as a verified release', async () => {
  const root = await mkdtemp('/tmp/staging-'); const schemas = new Schemas(); await schemas.load();
  try {
    const options = { releases: root, allowedSigners: '/unused', signer: 'release@thetis-agent' };
    await mkdir(join(root, '.staging.v0.1.0'));
    const busy = await stage('file:///unused', { tag: 'v0.1.0', commit: 'a'.repeat(40) }, options, schemas);
    assert.equal(busy.ok, false); assert.equal(busy.error.code, 'conflict');
    const outside = await stage('file:///unused', { tag: '../outside', commit: 'a'.repeat(40) }, options, schemas);
    assert.equal(outside.ok, false); assert.equal(outside.error.code, 'invalid-args');
  } finally { await rm(root, { recursive: true, force: true }); }
});
