/** Recheck installed release authority at the supervisor boundary, including the code it cannot hot-swap; ADR 0048, ADR 0052. */
import { realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshot } from '@/lib/snapshots/index.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Result, Schemas } from '@/lib/schema/index.ts';
import { readInstall } from './install.ts';
import { tags } from './stage.ts';
import { releaseTag } from './refs.ts';
import { verifyInstalled } from './verify.ts';

export async function authorizeRelease(prefix: string, release: string, schemas: Schemas): Promise<Result<void>> {
  const choices = await readInstall(prefix, schemas); if (!choices.ok) return choices;
  const root = await realpath(join(prefix, 'releases')).catch(() => '');
  const path = await realpath(release).catch(() => ''); const tag = basename(path);
  if (!root || dirname(path) !== root || !releaseTag.test(tag)) return failure('outside-roots', 'The requested release is not a staged version inside this installation.');
  const refs = await tags(choices.value.remote); if (!refs.ok) return refs;
  const bound = refs.value.find(entry => entry.tag === tag);
  if (!bound) return failure('conflict', 'The requested release no longer has an annotated tag at its recorded remote.');
  const verified = await verifyInstalled(path, { allowedSigners: choices.value.allowedSigners, signer: choices.value.signer, tag: bound }, schemas);
  if (!verified.ok) return verified;
  const serving = await snapshot(fileURLToPath(new URL('../maintenance/', import.meta.url))); if (!serving.ok) return serving;
  const candidate = await snapshot(join(path, 'lib/maintenance')); if (!candidate.ok) return candidate;
  return serving.value === candidate.value ? { ok: true, value: undefined }
    : failure('unsupported', 'This release changes the supervisor; an explicit service migration is required before applying its kernel.');
}
