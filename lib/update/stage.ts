/** Stage a release's bytes beside the serving one and promote it only after signature, tag, pin and artifact verification; ADR 0048, GN-002. */
import { copyFile, mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failure } from '@/lib/schema/index.ts';
import type { Result, Schemas } from '@/lib/schema/index.ts';
import { parseTags, refsLimits } from './refs.ts';
import type { Tag } from './refs.ts';
import { run } from './tool.ts';
import { verifyPins, verifyRelease } from './verify.ts';
import type { Verified } from './verify.ts';

export const stageLimits = { assetBytes: 134217728, totalBytes: 536870912, deadlineMs: 300000, entries: 64, outputBytes: 65536 };
export const releaseAssets = ['thetis-distribution.tar.gz', 'package.json', 'profile.lock.json', 'registry.json', 'registry.bundle', 'provenance.json', 'platform.txt', 'kernel-pins.json', 'SHA256SUMS', 'SHA256SUMS.sig'] as const;

function packet(payload: string): string { return `${(payload.length + 4).toString(16).padStart(4, '0')}${payload}`; }
const header = Buffer.from(`${packet('# service=git-upload-pack\n')}0000`);

/** A `file://` remote has no smart-HTTP layer, so the same advertisement is produced locally and framed with the header that transport adds. */
async function local(path: string): Promise<Result<Buffer>> {
  const advertised = await run('/usr/bin/git', ['upload-pack', '--advertise-refs', path], { cwd: '/', deadlineMs: stageLimits.deadlineMs, outputBytes: refsLimits.advertisementBytes });
  return advertised.ok ? { ok: true, value: Buffer.concat([header, advertised.value]) } : advertised;
}

async function fetched(url: string): Promise<Result<Buffer>> {
  const timer = new AbortController(); const deadline = setTimeout(() => { timer.abort(); }, stageLimits.deadlineMs);
  try {
    const response = await fetch(url, { signal: timer.signal, redirect: 'follow' });
    if (!response.ok || !response.body) return failure('io', `The release remote answered ${String(response.status)} for ${url}.`);
    const chunks: Uint8Array[] = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length; if (bytes > stageLimits.assetBytes) return failure('budget', 'A release asset exceeds its byte budget.');
      chunks.push(chunk);
    }
    return { ok: true, value: Buffer.concat(chunks, bytes) };
  } catch { return failure('io', `The release remote could not be reached at ${url}.`); }
  finally { clearTimeout(deadline); }
}

/** Read the runtime library's tags from the git reference advertisement: bounded bytes, no API token, no JSON. */
export async function tags(remote: string): Promise<Result<readonly Tag[]>> {
  const advertisement = remote.startsWith('file://')
    ? await local(fileURLToPath(remote))
    : await fetched(`${remote.replace(/\/$/u, '')}/info/refs?service=git-upload-pack`);
  return advertisement.ok ? parseTags(advertisement.value) : advertisement;
}

async function asset(source: string, destination: string): Promise<Result<number>> {
  if (!source.startsWith('file://')) {
    const bytes = await fetched(source); if (!bytes.ok) return bytes;
    await writeFile(destination, bytes.value, { mode: 0o600 });
    return { ok: true, value: bytes.value.length };
  }
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
  const collected = await collect(base, tag.tag, staging); if (!collected.ok) return collected;
  const verified = await verifyRelease(staging, { allowedSigners: options.allowedSigners, signer: options.signer, tag }, schemas); if (!verified.ok) return verified;
  const extracted = await run('/usr/bin/tar', ['-xzf', 'thetis-distribution.tar.gz'], { cwd: staging, deadlineMs: stageLimits.deadlineMs, outputBytes: stageLimits.outputBytes }); if (!extracted.ok) return extracted;
  const pinned = await verifyPins(staging, verified.value.pins); if (!pinned.ok) return pinned;
  return verified;
}

export interface StageOptions { allowedSigners: string; signer: string; releases: string }

/** Stage into `.staging.<tag>` and rename only once every check has passed, so `releases/` never holds unverified bytes. */
export async function stage(base: string, tag: Tag, options: StageOptions, schemas: Schemas): Promise<Result<{ path: string; verified: Verified }>> {
  const releases = await realpath(options.releases).catch(() => undefined);
  if (releases === undefined) return failure('io', 'The release directory does not exist.');
  if ((await readdir(releases)).length > stageLimits.entries) return failure('budget', 'The release directory exceeds its entry budget.');
  const final = join(releases, tag.tag); const staging = join(releases, `.staging.${tag.tag}`);
  if (await stat(final).then(() => true, () => false)) return failure('conflict', `Version ${tag.tag} is already staged at ${final}.`);
  const claimed = await mkdir(staging, { recursive: false, mode: 0o700 }).then(() => true, () => false);
  if (!claimed) return failure('conflict', `Version ${tag.tag} is already being staged.`);
  const verified = await prepared(base, tag, staging, options, schemas);
  if (!verified.ok) { await rm(staging, { recursive: true, force: true }); return verified; }
  const promoted = await rename(staging, final).then(() => true, () => false);
  if (!promoted) { await rm(staging, { recursive: true, force: true }); return failure('io', `Version ${tag.tag} could not be promoted into ${releases}.`); }
  return { ok: true, value: { path: final, verified: verified.value } };
}
