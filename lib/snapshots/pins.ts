/** Keep verified immutable pins independent of disposable run workspaces; GN-002, implementation note 0046. */
import { lstat, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { snapshot, verify } from './index.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';

export const pinLimits = { retained: 1024 };

export async function retainPin(root: string, source: string, hash: string, artifacts: boolean): Promise<Result<string>> {
  if (!/^sha256:[a-f0-9]{64}$/u.test(hash)) return failure('invalid-args', 'The pinned digest is invalid.');
  const destination = join(root, hash.slice(7)); const staging = join(root, `.pending-${randomUUID()}`);
  const result = await retain(root, source, hash, artifacts, destination, staging);
  try { await rm(staging, { recursive: true, force: true }); }
  catch { return failure('io', 'The pin staging directory could not be removed.'); }
  return result;
}

async function retain(root: string, source: string, hash: string, artifacts: boolean, destination: string, staging: string): Promise<Result<string>> {
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (await realpath(root) !== root) return failure('outside-roots', 'The retained pin root must be canonical.');
    const exists = await present(destination); if (!exists.ok) return exists;
    if (!exists.value) {
      if ((await readdir(root)).length >= pinLimits.retained) return failure('budget', 'The retained pin pool is full.');
      const copied = await snapshot(source, staging); if (!copied.ok) return copied;
      if (copied.value !== hash) return failure('invalid-args', 'The pinned hash does not match its tree.');
      const checked = artifacts ? await verify(staging) : copied; if (!checked.ok) return checked;
      await rename(staging, destination);
    } else {
      const copied = await snapshot(destination); if (!copied.ok) return copied;
      if (copied.value !== hash) return failure('hash-mismatch', 'The retained pin no longer matches its digest.');
      if (artifacts) { const checked = await verify(destination); if (!checked.ok) return checked; }
    }
    return { ok: true, value: destination };
  } catch { return failure('io', 'The immutable pin could not be retained.'); }
}

async function present(path: string): Promise<Result<boolean>> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && await realpath(path) === path ? { ok: true, value: true } : failure('outside-roots', 'The retained pin is not a canonical directory.');
  } catch (error) { return isObject(error) && error['code'] === 'ENOENT' ? { ok: true, value: false } : failure('io', 'The retained pin could not be inspected.'); }
}
