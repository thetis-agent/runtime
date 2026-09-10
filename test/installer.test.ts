/** Refuse an unsigned or altered release before any file exists under the prefix, and lay out a supervised deployment that validates; ADR 0048, ADR 0049, ADR 0050, GN-002. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Schemas, isObject } from '@/lib/schema/index.ts';
import { configuration } from '@/lib/deployment/index.ts';
import { readInstall } from '@/lib/update/install.ts';
import { buildRelease } from '@/test/release-fixture.ts';
import { git } from '@/lib/registry/git.ts';
import type { Fixture } from '@/test/release-fixture.ts';

const script = fileURLToPath(new URL('../install.sh', import.meta.url));
const units = fileURLToPath(new URL('../units/', import.meta.url));
const password = 'installer test password';
const limits = { outputBytes: 262144, deadlineMs: 600000 };

interface Run { status: number; stdout: string; stderr: string }

async function install(args: readonly string[], withPassword = true): Promise<Run> {
  const secret = await mkdtemp('/tmp/pw-'); const path = join(secret, 'password');
  await writeFile(path, `${password}\n`, { mode: 0o600 });
  const handle = withPassword ? await open(path, 'r') : undefined;
  try {
    return await new Promise<Run>((resolve, reject) => {
      const child = spawn('/bin/sh', [script, ...args], { env: { PATH: '/runtime/bin:/usr/bin:/bin', TMPDIR: '/tmp', HOME: secret },
        stdio: ['ignore', 'pipe', 'pipe', ...handle ? [handle.fd] : []] });
      let stdout = ''; let stderr = '';
      for (const [stream, sink] of [[child.stdout, 'out'], [child.stderr, 'err']] satisfies [typeof child.stdout, string][]) {
        stream?.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          if (sink === 'out') { if (stdout.length < limits.outputBytes) stdout += text; }
          else if (stderr.length < limits.outputBytes) stderr += text;
        });
      }
      child.once('error', reject);
      child.once('close', status => { resolve({ status: status ?? 1, stdout, stderr }); });
    });
  } finally { await handle?.close(); await rm(secret, { recursive: true, force: true }); }
}

interface Places { prefix: string; state: string; published: string; remote: string; roots: string[]; fixture: Fixture }

const identity = { GIT_AUTHOR_NAME: 'release', GIT_AUTHOR_EMAIL: 'release@thetis-agent', GIT_AUTHOR_DATE: '@0 +0000',
  GIT_COMMITTER_NAME: 'release', GIT_COMMITTER_EMAIL: 'release@thetis-agent', GIT_COMMITTER_DATE: '@0 +0000' };

/** `lib/registry/git.ts` runs against a git directory, so the tag the installer resolves is built with plumbing. */
async function remote(path: string, content: string): Promise<{ path: string; commit: string }> {
  const text = (result: Awaited<ReturnType<typeof git>>): string => { assert.ok(result.ok, JSON.stringify(result)); return result.value.toString('utf8').trim(); };
  assert.ok((await git(path, ['init', '--bare', '--quiet'])).ok);
  const blob = text(await git(path, ['hash-object', '-w', '--stdin'], Buffer.from(`${content}\n`)));
  const tree = text(await git(path, ['mktree'], Buffer.from(`100644 blob ${blob}\tREADME.md\n`)));
  const commit = text(await git(path, ['commit-tree', tree], Buffer.from(`${content}\n`), identity));
  const annotated = text(await git(path, ['mktag'], Buffer.from(`object ${commit}\ntype commit\ntag v0.1.0\ntagger release <release@thetis-agent> 0 +0000\n\nv0.1.0\n`)));
  assert.ok((await git(path, ['update-ref', 'refs/tags/v0.1.0', annotated])).ok);
  return { path, commit };
}

/** The state root must stay short: `<state>/g` above 18 bytes would push a target endpoint past the socket path limit (ADR 0050). */
async function places(tag: string): Promise<Places> {
  const state = await mkdtemp('/assembly/');
  const work = await mkdtemp('/assembly/w'); const published = join(work, 'published');
  await mkdir(published, { recursive: true });
  const built = await remote(join(work, 'runtime.git'), 'release remote');
  const fixture = await buildRelease(join(published, tag), { tag, commit: built.commit });
  return { prefix: join(work, 'opt'), state, published, remote: built.path, roots: [state, work], fixture };
}

function flags(at: Places, remoteOverride = at.remote): string[] {
  return ['--prefix', at.prefix, '--state', at.state, '--no-mount', '--service', 'none',
    '--release', at.fixture.tag, '--release-url', `file://${at.published}`, '--remote', `file://${remoteOverride}`,
    '--allowed-signers', at.fixture.allowedSigners, '--operator', 'op', '--password-fd', '3', '--origin', 'https://zero.test', '--yes'];
}

async function discard(at: Places): Promise<void> { for (const root of at.roots) await rm(root, { recursive: true, force: true }); }

await test('the installer refuses an update policy no record has accepted, and a state root that would break a target endpoint', async () => {
  const refused = await install(['--auto-update', 'fixes', '--origin', 'https://zero.test', '--dry-run'], false);
  assert.equal(refused.status, 1); assert.match(refused.stderr, /ADR 0049/u);
  const long = await install(['--state', '/var/lib/zero-deployment', '--origin', 'https://zero.test', '--dry-run'], false);
  assert.equal(long.status, 1); assert.match(long.stderr, /socket path limit/u);
  const unknown = await install(['--nonsense'], false);
  assert.equal(unknown.status, 1); assert.match(unknown.stderr, /Unknown flag/u);
  const help = await install(['--help'], false);
  assert.equal(help.status, 0); assert.match(help.stdout, /--password-fd/u);
});

await test('--dry-run prints the privileged steps in a stable order and writes nothing', async () => {
  const root = await mkdtemp('/tmp/dry-');
  try {
    // The golden output names the documented default paths; a dry run writes nothing, so naming them is safe.
    const run = await install(['--prefix', '/opt/zero', '--state', '/var/lib/z', '--origin', 'https://zero.test', '--operator', 'op', '--dry-run'], false);
    assert.equal(run.status, 0, run.stderr);
    const golden = await readFile(new URL('./fixtures/installer-dry-run.txt', import.meta.url), 'utf8');
    assert.equal(run.stdout, golden);
    assert.match(run.stdout, /^write accounts\.json \(1 account\)$/mu);
    assert.doesNotMatch(run.stdout, /\bop\b/u);
    assert.equal(await stat('/opt/zero').then(() => true, () => false), false, 'A dry run created the prefix.');
    assert.equal((await readdir(root)).length, 0, 'A dry run created a file under the temporary root.');
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('every embedded unit template is byte-identical to its reviewable copy', async () => {
  for (const name of ['zero.service', 'zero-update.service', 'zero-update.timer', 'state.mount']) {
    const printed = await install(['--print-unit', name], false);
    assert.equal(printed.status, 0, printed.stderr);
    assert.equal(printed.stdout, await readFile(join(units, name), 'utf8'), `${name} differs from the text the installer installs.`);
  }
  const absent = await install(['--print-unit', 'nonsense.service'], false);
  assert.equal(absent.status, 1); assert.match(absent.stderr, /no embedded unit/u);
});

await test('ADR 0048 a missing or forged signature stops the install before any file exists under the prefix', async () => {
  const at = await places('v0.1.0');
  try {
    const base = flags(at);
    const signature = join(at.fixture.dir, 'SHA256SUMS.sig');
    await rm(signature);
    const unsigned = await install(base);
    assert.equal(unsigned.status, 1); assert.match(unsigned.stderr, /SHA256SUMS\.sig is missing/u);
    assert.equal(await stat(at.prefix).then(() => true, () => false), false, 'A refused install left a file under the prefix.');
    await writeFile(signature, 'not a signature\n');
    const forged = await install(base);
    assert.equal(forged.status, 1); assert.match(forged.stderr, /signature/u);
    assert.equal(await stat(at.prefix).then(() => true, () => false), false);
  } finally { await discard(at); }
});

await test('ADR 0048 an altered asset is refused by the signed checksums, and a tag that resolves elsewhere by its provenance', async () => {
  const at = await places('v0.1.0');
  try {
    const asset = join(at.fixture.dir, 'registry.json');
    const original = await readFile(asset, 'utf8');
    await writeFile(asset, `${original} `);
    const altered = await install(flags(at));
    assert.equal(altered.status, 1); assert.match(altered.stderr, /checksums/u);
    assert.equal(await stat(at.prefix).then(() => true, () => false), false);
    await writeFile(asset, original);
    const other = await remote(join(at.roots[1] ?? '', 'other.git'), 'a different history');
    const elsewhere = await install(flags(at, other.path));
    assert.equal(elsewhere.status, 1); assert.match(elsewhere.stderr, /different commit than tag v0\.1\.0/u);
    assert.equal(await stat(at.prefix).then(() => true, () => false), false);
  } finally { await discard(at); }
});

await test('ADR 0048 a fresh install lays out a supervised deployment whose seed, accounts and recorded choices validate', async () => {
  const at = await places('v0.1.0'); const schemas = new Schemas(); await schemas.load();
  try {
    const prefix = at.prefix; const state = at.state;
    const run = await install(flags(at));
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.doesNotMatch(`${run.stdout}${run.stderr}`, new RegExp(password, 'u'));
    assert.match(run.stdout, /Sign in at https:\/\/zero\.test\/login as op$/mu);

    const seed = await configuration(join(prefix, 'etc/seed.json'), schemas);
    assert.ok(seed.ok, JSON.stringify(seed));
    const trusted = seed.value.trusted; assert.ok(trusted, 'The installed seed has no trusted kernel block.');
    assert.equal(trusted.keyFd, 4); assert.equal(trusted.administrator, 'op');
    assert.equal(seed.value.root, join(state, 'kernel'));
    assert.equal(seed.value.targets.length, 1); assert.equal(seed.value.targets[0]?.id, 'registry');
    const bootstrap = seed.value.bootstrap; assert.ok(bootstrap, 'The installed seed has no bootstrap block.');
    assert.equal(bootstrap.recipe, join(prefix, 'etc/recipe.json'));

    const recorded = await readInstall(prefix, schemas); assert.ok(recorded.ok, JSON.stringify(recorded));
    assert.equal(recorded.value.operator, 'op'); assert.equal(recorded.value.policy, 'none'); assert.equal(recorded.value.release, 'v0.1.0');
    assert.doesNotMatch(await readFile(join(prefix, 'etc/install.json'), 'utf8'), new RegExp(password, 'u'));
    assert.doesNotMatch(await readFile(join(prefix, 'etc/seed.json'), 'utf8'), new RegExp(password, 'u'));

    const accountsRaw: unknown = JSON.parse(await readFile(join(state, 'login-state/accounts.json'), 'utf8'));
    const accountsSchema: unknown = JSON.parse(await readFile(join(prefix, 'current/packages/gateway-login/schema.json'), 'utf8'));
    assert.ok(typeof accountsSchema === 'object' && accountsSchema !== null);
    const check = schemas.compile<{ version: 1; accounts: { id: string }[] }>({ ...accountsSchema });
    assert.ok(check(accountsRaw), 'accounts.json does not validate against the login authority contract.');
    assert.equal(accountsRaw.accounts.length, 1); assert.equal(accountsRaw.accounts[0]?.id, 'op');

    const recipe: unknown = JSON.parse(await readFile(join(prefix, 'etc/recipe.json'), 'utf8'));
    assert.ok(isObject(recipe) && Array.isArray(recipe['targets']));
    const listed: unknown[] = recipe['targets'];
    const ids = listed.flatMap(item => isObject(item) && typeof item['id'] === 'string' ? [item['id']] : []);
    assert.deepEqual(ids.filter(id => id.startsWith('bob')), []);
    assert.ok(ids.includes('op') && ids.includes('op-cli') && ids.includes('login') && ids.includes('update-status'), ids.join(','));

    assert.ok((await stat(join(prefix, 'bin/zero'))).mode & 0o111);
    assert.ok((await stat(join(prefix, 'etc/allowed_signers'))).isFile());
    assert.ok((await stat(join(state, 'g'))).isDirectory());
    assert.equal((await stat(join(state, 'login-state/accounts.json'))).mode & 0o777, 0o600);

    const again = await install(flags(at));
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /^Zero v0\.1\.0 is already installed at /mu);

    const removed = await install([...flags(at), '--uninstall']);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(await stat(prefix).then(() => true, () => false), false, '--uninstall left the prefix in place.');
    assert.ok((await stat(join(state, 'login-state/accounts.json'))).isFile(), '--uninstall removed state without --purge-state.');
  } finally { await discard(at); }
});
