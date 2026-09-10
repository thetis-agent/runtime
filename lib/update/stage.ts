/** Stage a release's bytes beside the serving one and promote it only after signature, tag, pin and artifact verification; ADR 0048, GN-002. */
import { copyFile, mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failure } from '@/lib/schema/index.ts';
import type { Result, Schemas } from '@/lib/schema/index.ts';
import { parseTags, refsLimits, releaseTag } from './refs.ts';
import type { Tag } from './refs.ts';
import { run } from './tool.ts';
import { download, fetched } from './download.ts';
import { verifyInstalled, verifyPins, verifyRelease } from './verify.ts';
import type { Verified } from './verify.ts';

export const stageLimits = { assetBytes: 134217728, totalBytes: 536870912, deadlineMs: 300000, entries: 64, outputBytes: 65536 };
export const releaseAssets = ['thetis-distribution.tar.gz', 'package.json', 'profile.lock.json', 'registry.json', 'registry.bundle', 'provenance.json', 'platform.txt', 'kernel-pins.json', 'install.sh', 'SHA256SUMS', 'SHA256SUMS.sig'] as const;

function packet(payload: string): string { return `${(payload.length + 4).toString(16).padStart(4, '0')}${payload}`; }
const header = Buffer.from(`${packet('# service=git-upload-pack\n')}0000`);

/** A `file://` remote has no smart-HTTP layer, so the same advertisement is produced locally and framed with the header that transport adds. */
async function local(path: string): Promise<Result<Buffer>> {
  const advertised = await run('/usr/bin/git', ['upload-pack', '--advertise-refs', path], { cwd: '/', deadlineMs: stageLimits.deadlineMs, outputBytes: refsLimits.advertisementBytes });
  return advertised.ok ? { ok: true, value: Buffer.concat([header, advertised.value]) } : advertised;
}

/** Read the runtime library's tags from the git reference advertisement: bounded bytes, no API token, no JSON. */
export async function tags(remote: string): Promise<Result<readonly Tag[]>> {
  if (!remote.startsWith('https://') && !remote.startsWith('file://')) return failure('invalid-args', 'Release remotes require https:// or file://.');
  const advertisement = remote.startsWith('file://')
    ? await local(fileURLToPath(remote))
    : await fetched(`${remote.replace(/\/$/u, '')}/info/refs?service=git-upload-pack`, refsLimits.advertisementBytes);
  return advertisement.ok ? parseTags(advertisement.value) : advertisement;
}

async function asset(source: string, destination: string): Promise<Result<number>> {
  if (!source.startsWith('file://')) return download(source, destination, stageLimits.assetBytes);
  const path = fileURLToPath(source); const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) return failure('io', `The release asset ${destination} is missing at its remote.`);
  if (info.size > stageLimits.assetBytes) return failure('budget', `The release asset ${destination} exceeds its byte budget.`);
  await copyFile(path, destination);
  return { ok: true, value: info.size };
}

async function collect(base: string, tag: string, staging: string): Promise<Result<void>> {
  let total = 0;
  for (const name of releaseAssets) {
    const copied = await asset(`${base.replace(/\/$/u, '')}/${tag}/${name}`, join(staging, name)); if (!copied.ok) return copied;
    total += copied.value;
    if (total > stageLimits.totalBytes) return failure('budget', 'The staged release exceeds its total byte budget.');
  }
  return { ok: true, value: undefined };
}

async function prepared(base: string, tag: Tag, staging: string, options: StageOptions, schemas: Schemas): Promise<Result<Verified>> {
  const metadata = join(staging, '.release'); await mkdir(metadata);
  const collected = await collect(base, tag.tag, metadata); if (!collected.ok) return collected;
  const verified = await verifyRelease(metadata, { allowedSigners: options.allowedSigners, signer: options.signer, tag }, schemas); if (!verified.ok) return verified;
  if (verified.value.provenance.node.version !== process.version) return failure('unsupported', `This release requires Node ${verified.value.provenance.node.version}; an explicit service migration is required.`);
  const extracted = await run('/usr/bin/tar', ['-xpzf', '.release/thetis-distribution.tar.gz', '--no-same-owner'], { cwd: staging, deadlineMs: stageLimits.deadlineMs, outputBytes: stageLimits.outputBytes }); if (!extracted.ok) return extracted;
  await copyFile(join(metadata, 'kernel-pins.json'), join(staging, 'kernel-pins.json'));
  const pinned = await verifyPins(staging, verified.value.pins); if (!pinned.ok) return pinned;
  return verified;
}

export interface StageOptions { allowedSigners: string; signer: string; releases: string }

/** Stage into `.staging.<tag>` and rename only once every check has passed, so `releases/` never holds unverified bytes. */
export async function stage(base: string, tag: Tag, options: StageOptions, schemas: Schemas): Promise<Result<{ path: string; verified: Verified }>> {
  if (!releaseTag.test(tag.tag) || !/^[a-f0-9]{40}$/u.test(tag.commit)) return failure('invalid-args', 'Staging requires a release tag and its resolved commit.');
  if (!base.startsWith('https://') && !base.startsWith('file://')) return failure('invalid-args', 'Release assets require https:// or file://.');
  const releases = await realpath(options.releases).catch(() => undefined);
  if (releases === undefined) return failure('io', 'The release directory does not exist.');
  if ((await readdir(releases)).length > stageLimits.entries) return failure('budget', 'The release directory exceeds its entry budget.');
  const final = join(releases, tag.tag); const staging = join(releases, `.staging.${tag.tag}`);
  if (await stat(final).then(() => true, () => false)) {
    if (await realpath(final) !== final) return failure('outside-roots', 'The staged release must be a canonical directory.');
    const verified = await verifyInstalled(final, { allowedSigners: options.allowedSigners, signer: options.signer, tag }, schemas);
    return verified.ok ? { ok: true, value: { path: final, verified: verified.value } } : verified;
  }
  const claimed = await mkdir(staging, { recursive: false, mode: 0o700 }).then(() => true, () => false);
  if (!claimed) return failure('conflict', `Version ${tag.tag} is already being staged.`);
  const verified = await prepared(base, tag, staging, options, schemas).catch(() => failure('io', 'The staged release could not be prepared.'));
  if (!verified.ok) { await rm(staging, { recursive: true, force: true }); return verified; }
  const promoted = await rename(staging, final).then(() => true, () => false);
  if (!promoted) { await rm(staging, { recursive: true, force: true }); return failure('io', `Version ${tag.tag} could not be promoted into ${releases}.`); }
  return { ok: true, value: { path: final, verified: verified.value } };
}
