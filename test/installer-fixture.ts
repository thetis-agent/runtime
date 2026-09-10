/** Share the signed offline installer fixture and descriptor-only password runner; ADR 0048, implementation note 0052. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRelease } from '@/test/release-fixture.ts';
import { git } from '@/lib/registry/git.ts';
import type { Fixture } from '@/test/release-fixture.ts';

const script = fileURLToPath(new URL('../install.sh', import.meta.url));
export const password = 'six-ok';
export const apiKey = 'fixture-provider-key';
const limits = { outputBytes: 262144, deadlineMs: 600000 };

interface Run { status: number; stdout: string; stderr: string }

export function install(args: readonly string[], withPassword = true, environment: Readonly<Record<string, string>> = {}): Promise<Run> {
  return command('/bin/sh', [script, ...args], withPassword, environment);
}

export async function command(executable: string, args: readonly string[], withPassword = true, environment: Readonly<Record<string, string>> = {}): Promise<Run> {
  const secret = await mkdtemp('/tmp/pw-'); const path = join(secret, 'password');
  await writeFile(path, `${password}\n`, { mode: 0o600 });
  const keyPath = join(secret, 'api-key'); await writeFile(keyPath, apiKey, { mode: 0o600 });
  const handle = withPassword ? await open(path, 'r') : undefined;
  const keyHandle = withPassword ? await open(keyPath, 'r') : undefined;
  try {
    return await new Promise<Run>((resolve, reject) => {
      const child = spawn(executable, [...args], { env: { PATH: '/usr/bin:/bin', TMPDIR: '/installation', HOME: secret, ...environment },
        stdio: ['ignore', 'pipe', 'pipe', ...handle && keyHandle ? [handle.fd, keyHandle.fd] : []] });
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, limits.deadlineMs);
      let stdout = ''; let stderr = '';
      for (const [stream, sink] of [[child.stdout, 'out'], [child.stderr, 'err']] satisfies [typeof child.stdout, string][]) {
        stream?.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          if (sink === 'out') { if (stdout.length < limits.outputBytes) stdout += text; }
          else if (stderr.length < limits.outputBytes) stderr += text;
        });
      }
      child.once('error', reject);
      child.once('close', status => { clearTimeout(timer); resolve({ status: status ?? 1, stdout, stderr }); });
    });
  } finally { await handle?.close(); await keyHandle?.close(); await rm(secret, { recursive: true, force: true }); }
}

export interface Places { prefix: string; state: string; published: string; remote: string; roots: string[]; fixture: Fixture }

const identity = { GIT_AUTHOR_NAME: 'release', GIT_AUTHOR_EMAIL: 'release@thetis-agent', GIT_AUTHOR_DATE: '@0 +0000',
  GIT_COMMITTER_NAME: 'release', GIT_COMMITTER_EMAIL: 'release@thetis-agent', GIT_COMMITTER_DATE: '@0 +0000' };

/** `lib/registry/git.ts` runs against a git directory, so the tag the installer resolves is built with plumbing. */
export async function remote(path: string, content: string): Promise<{ path: string; commit: string }> {
  const text = (result: Awaited<ReturnType<typeof git>>): string => { assert.ok(result.ok, JSON.stringify(result)); return result.value.toString('utf8').trim(); };
  assert.ok((await git(path, ['init', '--bare', '--quiet'])).ok);
  const blob = text(await git(path, ['hash-object', '-w', '--stdin'], Buffer.from(`${content}\n`)));
  const tree = text(await git(path, ['mktree'], Buffer.from(`100644 blob ${blob}\tREADME.md\n`)));
  const commit = text(await git(path, ['commit-tree', tree], Buffer.from(`${content}\n`), identity));
  const annotated = text(await git(path, ['mktag'], Buffer.from(`object ${commit}\ntype commit\ntag v0.1.0\ntagger release <release@thetis-agent> 0 +0000\n\nv0.1.0\n`)));
  assert.ok((await git(path, ['update-ref', 'refs/tags/v0.1.0', annotated])).ok);
  return { path, commit };
}

/** The state root must stay short: `<state>/g` above 18 bytes would push a target endpoint past the socket path limit (implementation note 0050). */
export async function places(tag: string): Promise<Places> {
  const state = await mkdtemp('/d/');
  const work = await mkdtemp('/installation/w'); const published = join(work, 'published');
  await mkdir(published, { recursive: true });
  const built = await remote(join(work, 'runtime.git'), 'release remote');
  const fixture = await buildRelease(join(published, tag), { tag, commit: built.commit, nodeArchive: true });
  return { prefix: join(work, 'opt'), state, published, remote: built.path, roots: [state, work], fixture };
}

export function flags(at: Places, remoteOverride = at.remote): string[] {
  return ['--prefix', at.prefix, '--state', at.state, '--no-mount', '--service', 'none',
    '--release', at.fixture.tag, '--release-url', `file://${at.published}`, '--remote', `file://${remoteOverride}`, '--node-url', at.fixture.nodeUrl,
    '--allowed-signers', at.fixture.allowedSigners, '--operator', 'op', '--password-fd', '3', '--origin', 'https://thetis.test', '--yes', '--demo'];
}

export async function discard(at: Places): Promise<void> { for (const root of at.roots) await rm(root, { recursive: true, force: true }); }
