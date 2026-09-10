/** Refuse an unsigned, mistagged or tampered release before install or update; ADR 0048, GN-002. */
import { realpath } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import { readBounded } from '@/lib/files/read-bounded.ts';
import { snapshot } from '@/lib/snapshots/index.ts';
import { verifyTree } from '@/lib/artifacts/verify-tree.ts';
import { run } from './tool.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Result, Schemas } from '@/lib/schema/index.ts';
import type { Tag } from './refs.ts';

export const verifyLimits = { sumsBytes: 65536, provenanceBytes: 65536, pinsBytes: 65536, assetBytes: 134217728, deadlineMs: 60000, pins: 64 };

/** The eight assets a GitHub Release for this repository carries, matching docs/ci-delivery.md. */
const releaseAssets = ['thetis-distribution.tar.gz', 'package.json', 'profile.lock.json', 'registry.json', 'registry.bundle', 'provenance.json', 'platform.txt', 'kernel-pins.json'] as const;

export interface Provenance {
  version: 1;
  runtime: { repository: string; commit: string };
  packages: { repository: string; commit: string };
  node: { version: string; sha256: Readonly<Record<string, string>> };
  generator: string; workflow: string; run: string;
}
export interface Verified { provenance: Provenance; pins: Readonly<Record<string, string>>; entry: string }
export interface VerifyOptions { allowedSigners: string; signer: string; tag: Tag }

function relativePath(value: string): boolean {
  return value.length > 0 && !value.startsWith('/') && !value.includes('\0') &&
    value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

function assetNames(buffer: Buffer): Result<void> {
  const lines = buffer.toString('utf8').split('\n').filter(line => line.length > 0);
  if (lines.length !== releaseAssets.length) return failure('invalid-args', 'SHA256SUMS does not list exactly the expected release assets.');
  const seen = new Set<string>();
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) [ *](.+)$/u.exec(line);
    const name = match?.[2];
    if (!match || !name || !releaseAssets.includes(name as typeof releaseAssets[number]) || seen.has(name)) {
      return failure('invalid-args', 'SHA256SUMS lists a missing, extra, duplicate or malformed release asset.');
    }
    seen.add(name);
  }
  return { ok: true, value: undefined };
}

function toolFailure<C extends string>(result: { ok: false; error: { code: string; message: string } }, fallback: C, message: string): Result<never, C | 'deadline' | 'budget'> {
  return result.error.code === 'deadline' || result.error.code === 'budget' ? failure(result.error.code, result.error.message) : failure(fallback, message);
}

async function verifiedProvenance(root: string, schemas: Schemas): Promise<Result<Provenance>> {
  const raw = await readBounded(join(root, 'provenance.json'), verifyLimits.provenanceBytes); if (!raw.ok) return raw;
  let parsed: unknown;
  try { parsed = JSON.parse(raw.value.toString('utf8')); } catch { return failure('invalid-args', 'provenance.json is not valid JSON.'); }
  const validate = schemas.compile<Provenance>({
    type: 'object', required: ['version', 'runtime', 'packages', 'node', 'generator', 'workflow', 'run'],
    properties: {
      version: { const: 1 },
      runtime: { type: 'object', required: ['repository', 'commit'], properties: { repository: { type: 'string', minLength: 1 }, commit: { type: 'string', pattern: '^[a-f0-9]{40}$' } } },
      packages: { type: 'object', required: ['repository', 'commit'], properties: { repository: { type: 'string', minLength: 1 }, commit: { type: 'string', minLength: 1 } } },
      node: { type: 'object', required: ['version', 'sha256'], properties: {
        version: { type: 'string', pattern: '^v\\d+\\.\\d+\\.\\d+$' },
        sha256: { type: 'object', minProperties: 1, additionalProperties: { type: 'string', pattern: '^[a-f0-9]{64}$' } }
      } },
      generator: { type: 'string', minLength: 1 }, workflow: { type: 'string', minLength: 1 }, run: { type: 'string', minLength: 1 }
    }
  });
  return validate(parsed) ? { ok: true, value: parsed } : failure('invalid-args', 'provenance.json does not match the release provenance contract.');
}

interface Pins { entry: string; pins: Readonly<Record<string, string>> }
async function verifiedPins(root: string, schemas: Schemas): Promise<Result<Pins>> {
  const raw = await readBounded(join(root, 'kernel-pins.json'), verifyLimits.pinsBytes); if (!raw.ok) return raw;
  let parsed: unknown;
  try { parsed = JSON.parse(raw.value.toString('utf8')); } catch { return failure('invalid-args', 'kernel-pins.json is not valid JSON.'); }
  const validate = schemas.compile<Pins>({
    type: 'object', required: ['entry', 'pins'],
    properties: {
      entry: { type: 'string', minLength: 1 },
      pins: { type: 'object', minProperties: 1, maxProperties: verifyLimits.pins, additionalProperties: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' } }
    }
  });
  if (!validate(parsed)) return failure('invalid-args', 'kernel-pins.json does not match the kernel pin contract.');
  if (!relativePath(parsed.entry) || !Object.keys(parsed.pins).every(relativePath)) return failure('invalid-args', 'kernel-pins.json names a pin outside the release tree.');
  return { ok: true, value: parsed };
}

/** Verify a locally staged release directory against an embedded `allowed_signers` file and the
 * commit the release tag peeled to. `dir` holds the eight assets named in `releaseAssets` plus
 * `SHA256SUMS.sig`; the caller resolves the tag and downloads the assets. */
export async function verifyRelease(dir: string, options: VerifyOptions, schemas: Schemas): Promise<Result<Verified>> {
  let root: string;
  try { root = await realpath(dir); } catch { return failure('io', 'The release directory could not be read.'); }
  const sums = await readBounded(join(root, 'SHA256SUMS'), verifyLimits.sumsBytes); if (!sums.ok) return sums;
  const signed = await run('/usr/bin/ssh-keygen', ['-Y', 'verify', '-f', options.allowedSigners, '-I', options.signer, '-n', 'zero-release', '-s', join(root, 'SHA256SUMS.sig')],
    { cwd: root, input: sums.value, deadlineMs: verifyLimits.deadlineMs, outputBytes: verifyLimits.sumsBytes });
  if (!signed.ok) return toolFailure(signed, 'forbidden', 'The release SHA256SUMS signature could not be verified against the allowed signer.');
  const checked = await run('/usr/bin/sha256sum', ['--check', '--strict', 'SHA256SUMS'], { cwd: root, deadlineMs: verifyLimits.deadlineMs, outputBytes: verifyLimits.sumsBytes });
  if (!checked.ok) return toolFailure(checked, 'hash-mismatch', 'The release assets do not match their signed SHA256SUMS checksums.');
  const names = assetNames(sums.value); if (!names.ok) return names;
  const provenance = await verifiedProvenance(root, schemas); if (!provenance.ok) return provenance;
  if (provenance.value.runtime.commit !== options.tag.commit) return failure('conflict', `provenance.json's runtime commit does not match tag ${options.tag.tag}.`);
  const pins = await verifiedPins(root, schemas); if (!pins.ok) return pins;
  return { ok: true, value: { provenance: provenance.value, pins: pins.value.pins, entry: pins.value.entry } };
}

/** Verify an extracted release tree's kernel code pins and ADR 0037 execution artifacts, after
 * `verifyRelease` has already confirmed the published pin hashes are signed and tag-matched. */
export async function verifyPins(root: string, pins: Readonly<Record<string, string>>): Promise<Result<void>> {
  let base: string;
  try { base = await realpath(root); } catch { return failure('io', 'The extracted release tree could not be read.'); }
  for (const [directory, expected] of Object.entries(pins)) {
    if (!relativePath(directory)) return failure('outside-roots', `The kernel pin ${directory} is not a canonical relative directory.`);
    let canonical: string;
    try { canonical = await realpath(join(base, directory)); } catch { return failure('io', `The kernel pin directory ${directory} is missing.`); }
    const outside = relative(base, canonical);
    if (outside === '..' || outside.startsWith(`..${sep}`) || isAbsolute(outside)) return failure('outside-roots', `The kernel pin directory ${directory} escapes the release tree.`);
    const hash = await snapshot(canonical); if (!hash.ok) return hash;
    if (hash.value !== expected) return failure('hash-mismatch', `The kernel pin directory ${directory} does not match its published hash.`);
  }
  const tree = await verifyTree(base);
  return tree.ok ? { ok: true, value: undefined } : tree;
}
