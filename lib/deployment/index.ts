/** Admit bounded deployment data without executing package code; ADR 0016, GN-002. */
import { readFile } from 'node:fs/promises';
import { readBounded } from '@/lib/files/read-bounded.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Result, Schemas } from '@/lib/schema/index.ts';
import { validators } from '@/lib/evaluation/index.ts';
import { releaseDigest } from './release.ts';
import { validator } from '@/lib/package-loader/index.ts';
import type { Entry } from '@/lib/package-loader/types.ts';
import type { Deployment, Target, Trusted, Release } from './types.ts';

export type ConfiguredTarget = Target & { entries: Entry[] };
export type ConfiguredRelease = Pick<Release, 'digest'> & { targets: ConfiguredTarget[] };
export type ConfiguredTrust = Pick<Trusted, 'origin' | 'socket' | 'keyFd' | 'administrator' | 'baseline' | 'digest' | 'plans' | 'execution'> & { releases: ConfiguredRelease[] };
export type Configuration = Pick<Deployment, 'version' | 'root' | 'cgroup' | 'identity' | 'bootstrap' | 'work'> & { targets: ConfiguredTarget[]; trusted?: ConfiguredTrust };
export const limits = { configurationBytes: 1048576 };

export async function configuration(path: string, schemas: Schemas): Promise<Result<Configuration>> {
  const bytes = await readBounded(path, limits.configurationBytes); if (!bytes.ok) return bytes;
  const raw: unknown = JSON.parse(await readFile(new URL('./schema.json', import.meta.url), 'utf8'));
  if (!isObject(raw)) throw new Error('The committed deployment schema is invalid.');
  let input: unknown;
  try { input = JSON.parse(bytes.value.toString('utf8')); } catch { return failure('invalid-args', 'The deployment configuration has invalid JSON.'); }
  validators(schemas);
  if (!schemas.compile<Deployment>(raw)(input)) return failure('invalid-args', 'The deployment configuration violates its schema.');
  const check = await validator<Entry>(schemas, 'entry'); const targets: ConfiguredTarget[] = [];
  for (const target of input.targets) {
    const entries: Entry[] = [];
    for (const entry of target.entries) { if (!check(entry)) return failure('invalid-args', 'The configured package entry violates its schema.'); entries.push(entry); }
    targets.push({ ...target, entries });
  }
  const releases: ConfiguredRelease[] = [];
  for (const release of input.trusted?.releases ?? []) {
    if (releaseDigest(release.targets) !== release.digest) return failure('hash-mismatch', 'The default release does not match its configured target digest.');
    const targets: ConfiguredTarget[] = [];
    for (const target of release.targets) {
      const entries: Entry[] = [];
      for (const entry of target.entries) { if (!check(entry)) return failure('invalid-args', 'The default package entry violates its schema.'); entries.push(entry); }
      targets.push({ ...target, entries });
    }
    releases.push({ ...release, targets });
  }
  if (new Set(targets.map(target => target.id)).size !== targets.length) return failure('collision', 'The deployment repeats a target identity.');
  const { trusted, ...base } = input;
  return { ok: true, value: { ...base, targets, ...(trusted ? { trusted: { ...trusted, releases } } : {}) } };
}
