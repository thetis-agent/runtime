/** Resolve only the configured local registry and preserve immutable pins; ADR 0007, GN-002. */
import { readFile, realpath, mkdtemp, rm, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { git, limits, reference } from './git.ts';
import { extract } from './tree.ts';
import { publish } from './publish.ts';
import { snapshot } from '@/lib/snapshots/index.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Schemas, Result, Validator } from '@/lib/schema/index.ts';
import { validator } from '@/lib/package-loader/index.ts';
import { readBounded } from '@/lib/files/read-bounded.ts';
import { matches } from '@/lib/semver-match/index.ts';
import type { Manifest } from '@/lib/package-loader/types.ts';
import type { Pin, Release } from './types.ts';
export type { Pin, Release, Lock } from './types.ts';

export class Registry {
  readonly path: string; readonly #manifest: Validator<Manifest>; readonly #pin: Validator<Pin>;
  private constructor(path: string, manifest: Validator<Manifest>, pin: Validator<Pin>) { this.path = path; this.#manifest = manifest; this.#pin = pin; }
  static async open(path: string, schemas: Schemas): Promise<Result<Registry>> {
    let canonical: string;
    try {
      canonical = await realpath(path);
      const format = await git(canonical, ['rev-parse', '--show-object-format']);
      if (!format.ok || format.value.toString('utf8').trim() !== 'sha1') return failure('invalid-args', 'The configured registry does not use supported git commit hashes.');
      const bare = await git(canonical, ['rev-parse', '--is-bare-repository']);
      if (!bare.ok || bare.value.toString('utf8').trim() !== 'true') return failure('invalid-args', 'The configured registry is not a local bare repository.');
    } catch { return failure('io', 'The configured registry does not exist or cannot be read.'); }
    const schema: unknown = JSON.parse(await readFile(new URL('../../contracts/registry/schema.json', import.meta.url), 'utf8'));
    if (!isObject(schema)) throw new Error('The committed registry schema is invalid.');
    return { ok: true, value: new Registry(canonical, await validator<Manifest>(schemas, 'manifest'), schemas.compile<Pin>({ ...schema, $id: 'thetis://internal/registry/pin', $ref: '#/$defs/pin' })) };
  }
  async inspect(name: string, version: string): Promise<Result<Release>> {
    if (!/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?$/u.test(name) || !matches(version, '*')) return failure('invalid-args', 'The package name or version is invalid.');
    let resolved = await git(this.path, ['rev-parse', '--verify', `${reference(name, version)}^{commit}`]);
    if (!resolved.ok) resolved = await git(this.path, ['rev-parse', '--verify', `refs/thetis/hidden/${name}@${version}^{commit}`]);
    if (!resolved.ok) return failure('not-found', 'The package version does not exist in the configured registry.');
    const commit = resolved.value.toString('utf8').trim(); const metadata = await git(this.path, ['show', '-s', '--format=%B', commit]); if (!metadata.ok) return metadata;
    try {
      const value: unknown = JSON.parse(metadata.value.toString('utf8'));
      if (!isObject(value)) return failure('invalid-args', 'The release metadata is invalid.');
      const pin = { name, version, commit, hash: value['hash'] };
      if (!this.#pin(pin) || value['name'] !== name || value['version'] !== version || typeof value['at'] !== 'number' || !Number.isSafeInteger(value['at']) || value['at'] < 0 || typeof value['note'] !== 'string' || Buffer.byteLength(value['note']) > limits.noteBytes) return failure('invalid-args', 'The release metadata is invalid.');
      return { ok: true, value: { pin, at: value['at'], note: value['note'] } };
    } catch { return failure('invalid-args', 'The release metadata is invalid.'); }
  }
  async manifest(pin: Pin): Promise<Result<Manifest>> {
    if (!this.#pin(pin)) return failure('invalid-args', 'The package pin is invalid.');
    const file = await git(this.path, ['show', `${pin.commit}:package.json`]); if (!file.ok) return file;
    try {
      const value: unknown = JSON.parse(file.value.toString('utf8'));
      return this.#manifest(value) && value.name === pin.name && value.version === pin.version ? { ok: true, value } : failure('invalid-args', 'The pinned package manifest is invalid.');
    } catch { return failure('invalid-args', 'The pinned package manifest is invalid.'); }
  }
  async versions(): Promise<Result<Release[]>> {
    const refs = await git(this.path, ['for-each-ref', '--format=%(refname:strip=2)', 'refs/tags/']); if (!refs.ok) return refs;
    const names = refs.value.toString('utf8').trim().split('\n').filter(Boolean);
    if (names.length > limits.versions) return failure('budget', 'The registry exceeds its version limit.');
    const result: Release[] = [];
    for (const name of names) {
      const split = name.lastIndexOf('@'); const item = await this.inspect(name.slice(0, split), name.slice(split + 1)); if (!item.ok) return item; result.push(item.value);
    }
    return { ok: true, value: result };
  }
  async search(requirement: string, range: string): Promise<Result<Pin[]>> {
    const versions = await this.versions(); if (!versions.ok) return versions;
    const result: Pin[] = [];
    for (const release of versions.value) {
      const manifest = await this.manifest(release.pin); if (!manifest.ok) return manifest;
      const provision = requirement === manifest.value.name ? manifest.value.version : manifest.value.provides[requirement];
      if (provision && matches(provision, range)) result.push(release.pin);
    }
    return { ok: true, value: result };
  }
  async publish(source: string, note: string, at: number): Promise<Result<Pin>> {
    try {
      const file = await readBounded(join(await realpath(source), 'package.json'), 65536); if (!file.ok) return file;
      const manifest: unknown = JSON.parse(file.value.toString('utf8'));
      if (!this.#manifest(manifest) || !matches(manifest.version, '*')) return failure('invalid-args', 'The package manifest is invalid.');
      for (const name of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) if (isObject(manifest[name]) && Object.keys(manifest[name]).length) return failure('gap', 'Published packages require registry packages through requires; external dependencies exist.');
      const retired = await git(this.path, ['show-ref', '--verify', `refs/thetis/retired/${manifest.name}@${manifest.version}`]);
      if (retired.ok) return failure('conflict', 'The package version was retired and cannot be reused.');
      return await publish(this.path, source, manifest, note, at);
    } catch { return failure('io', 'The package could not be read for publication.'); }
  }
  async fetch(pin: Pin, destination: string): Promise<Result<string>> {
    if (!this.#pin(pin)) return failure('invalid-args', 'The package pin is invalid.');
    const release = await this.inspect(pin.name, pin.version); if (!release.ok) return release;
    if (release.value.pin.commit !== pin.commit || release.value.pin.hash !== pin.hash) return failure('hash-mismatch', 'The registry version does not match the pinned hash.');
    let temporary: string | undefined;
    try {
      temporary = await mkdtemp(join(await realpath(dirname(destination)), '.registry-'));
      const extracted = await extract(this.path, pin.commit, temporary); if (!extracted.ok) return extracted;
      const hash = await snapshot(temporary); if (!hash.ok) return hash;
      if (hash.value !== pin.hash) return failure('hash-mismatch', 'The extracted package does not match the pinned hash.');
      await rename(temporary, destination); return { ok: true, value: destination };
    } catch { return failure('io', 'The pinned package could not be installed.'); }
    finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
  }
}
