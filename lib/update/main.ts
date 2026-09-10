/** Give one operator command the whole update path while leaving the act a person's press; ADR 0048, ADR 0049, GN-007. */
import { readdir, rm, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Schemas, failure } from '@/lib/schema/index.ts';
import type { Result, Schemas as Compiler } from '@/lib/schema/index.ts';
import { atomicWrite } from '@/lib/files/atomic.ts';
import { ask, report } from './control.ts';
import type { Report } from './control.ts';
import { controlPath, honoured, readInstall, releases, statusPath } from './install.ts';
import type { Install } from './install.ts';
import { login, publicSocket } from './login.ts';
import { readPassword } from './password.ts';
import { select } from './policy.ts';
import { stage, tags } from './stage.ts';
import { writeStatus } from './status.ts';
import type { Tag } from './refs.ts';

export const mainLimits = { releases: 64, arguments: 16 };
export interface Options { prefix: string; release?: string; passwordFd?: number; check: boolean; apply: boolean }

export function options(argv: readonly string[]): Result<{ command: string; options: Options }> {
  if (argv.length > mainLimits.arguments) return failure('invalid-args', 'The update command takes at most sixteen arguments.');
  const command = argv[0] ?? '';
  if (!['status', 'update', 'undo', 'prune-releases'].includes(command)) return failure('invalid-args', 'The commands are status, update, undo and prune-releases.');
  const parsed: Options = { prefix: fileURLToPath(new URL('../..', import.meta.url)), check: false, apply: false };
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--check') { parsed.check = true; continue; }
    if (flag === '--apply') { parsed.apply = true; continue; }
    const value = argv[++index];
    if (value === undefined || !['--prefix', '--release', '--password-fd'].includes(flag ?? '')) return failure('invalid-args', `The update command does not accept ${String(flag)}.`);
    if (flag === '--prefix') parsed.prefix = value;
    else if (flag === '--release') parsed.release = value;
    else if (!/^\d{1,3}$/u.test(value)) return failure('invalid-args', 'A password descriptor is a small non-negative integer.');
    else parsed.passwordFd = Number(value);
  }
  if (command === 'update' && parsed.check === parsed.apply) return failure('invalid-args', 'The update command needs exactly one of --check and --apply.');
  return { ok: true, value: { command, options: parsed } };
}

/** Only same-major versions are reported: that is the widest range any policy could apply, and a major version is a person's migration. */
function newest(current: string, found: readonly Tag[]): Tag | undefined {
  return found.filter(tag => select(current, [tag.tag], 'improvements') === tag.tag)
    .reduce<Tag | undefined>((best, tag) => best === undefined || select(best.tag, [tag.tag], 'improvements') === tag.tag ? tag : best, undefined);
}

async function check(install: Install, schemas: Compiler): Promise<Result<string>> {
  const policy = honoured(install.policy); if (!policy.ok) return policy;
  const found = await tags(install.remote); if (!found.ok) return found;
  const available = newest(install.release, found.value);
  const at = Date.now();
  if (!available) {
    const recorded = await writeStatus(statusPath(install), { version: 1, current: install.release, verified: false, checkedAt: at, policy: install.policy });
    return recorded.ok ? { ok: true, value: `Zero ${install.release} is the newest version.` } : recorded;
  }
  const staged = await stage(install.releaseUrl, available, { allowedSigners: install.allowedSigners, signer: install.signer, releases: releases(install) }, schemas);
  const verified = staged.ok || staged.error.code === 'conflict';
  const recorded = await writeStatus(statusPath(install), { version: 1, current: install.release, available: available.tag, verified, checkedAt: at, ...verified ? { stagedAt: at } : {}, policy: install.policy });
  if (!recorded.ok) return recorded;
  return verified ? { ok: true, value: `Version ${available.tag} is available and verified. Run zero update --apply to change the kernel.` } : staged;
}

async function authorized(install: Install, view: Report, options: Options): Promise<Result<string>> {
  const password = await readPassword(options.passwordFd); if (!password.ok) return password;
  return login(publicSocket(view.state, install.login), install.operator, password.value);
}

async function apply(install: Install, options: Options, method: 'update' | 'undo'): Promise<Result<string>> {
  const control = controlPath(install);
  const view = await report(control); if (!view.ok) return view;
  if (view.value.view.state !== 'LIVE') return failure('conflict', `The kernel is ${view.value.view.state}; read zero status and reset the target before changing its code.`);
  const target = method === 'undo' ? view.value.previous : join(releases(install), options.release ?? '');
  if (method === 'undo' && target === null) return failure('invalid-args', 'There is no previous version to undo to.');
  if (method === 'update' && !options.release) return failure('invalid-args', 'An update needs --release with the version to serve.');
  const session = await authorized(install, view.value, options); if (!session.ok) return session;
  const changed = await ask(control, method, { session: session.value, baseline: view.value.view.current.n, ...method === 'update' ? { release: target } : {} });
  if (!changed.ok) return changed;
  const after = await report(control); if (!after.ok) return after;
  const pointed = await point(install, after.value.release); if (!pointed.ok) return pointed;
  return { ok: true, value: `The kernel serves generation ${String(after.value.view.current.n)} from ${after.value.release}. Its public sockets are under ${after.value.state}.` };
}

/** `current` names what the supervisor was last told to serve; a symlink is replaced, never edited in place. */
async function point(install: Install, release: string): Promise<Result<void>> {
  const pending = join(install.prefix, `.current.${String(process.pid)}`);
  try { await symlink(release, pending); await rename(pending, join(install.prefix, 'current')); }
  catch { await rm(pending, { force: true }); return failure('io', 'The serving release link could not be replaced.'); }
  const tag = release.split('/').at(-1) ?? install.release;
  return atomicWrite(join(install.prefix, 'etc/install.json'), Buffer.from(`${JSON.stringify({ ...install, release: tag })}\n`));
}

async function prune(install: Install): Promise<Result<string>> {
  const view = await report(controlPath(install)); if (!view.ok) return view;
  if (view.value.view.state !== 'LIVE') return failure('conflict', `The kernel is ${view.value.view.state}; no release is retired while a transaction is open.`);
  const kept = new Set([view.value.release, view.value.previous].flatMap(path => path === null ? [] : [path.split('/').at(-1) ?? '']));
  const entries = await readdir(releases(install));
  if (entries.length > mainLimits.releases) return failure('budget', 'The release directory exceeds its entry budget.');
  const removed: string[] = [];
  for (const entry of entries.filter(name => !kept.has(name) && /^v\d/u.test(name))) { await rm(join(releases(install), entry), { recursive: true, force: true }); removed.push(entry); }
  return { ok: true, value: removed.length ? `Retired ${removed.join(', ')}; ${[...kept].join(' and ')} are kept.` : `Nothing to retire; ${[...kept].join(' and ')} are kept.` };
}

async function status(install: Install): Promise<Result<string>> {
  const view = await report(controlPath(install)); if (!view.ok) return view;
  const lines = [`state ${view.value.view.state} generation ${String(view.value.view.current.n)} release ${view.value.release}`,
    `previous ${view.value.previous ?? 'none'}`, `sockets ${view.value.state}`, `update policy ${install.policy}`, `sign in at ${install.origin}/login as ${install.operator}`];
  return { ok: true, value: lines.join('\n') };
}

export async function run(argv: readonly string[]): Promise<Result<string>> {
  const parsed = options(argv); if (!parsed.ok) return parsed;
  const schemas = new Schemas(); await schemas.load();
  const install = await readInstall(parsed.value.options.prefix, schemas); if (!install.ok) return install;
  switch (parsed.value.command) {
    case 'status': return status(install.value);
    case 'update': return parsed.value.options.check ? check(install.value, schemas) : apply(install.value, parsed.value.options, 'update');
    case 'undo': return apply(install.value, parsed.value.options, 'undo');
    case 'prune-releases': return prune(install.value);
    default: return failure('invalid-args', 'The commands are status, update, undo and prune-releases.');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await run(process.argv.slice(2));
  if (result.ok) process.stdout.write(`${result.value}\n`);
  else { process.stderr.write(`${result.error.message}\n`); process.exitCode = 1; }
}
