/** Keep conversation identities inside the assigned environment state; KS-004, proposal §6. */
import { mkdir, realpath, opendir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SessionCreateParams } from '../../contracts/kernel-socket/types.ts';
import type { Schemas, Result, Validator } from '../../lib/schema/index.ts';
import { failure, isObject } from '../../lib/schema/index.ts';
import { readBounded } from '../../lib/files/read-bounded.ts';
import { resolvePath } from '../../lib/files/index.ts';
import { atomicWrite, syncDirectory } from '../../lib/files/atomic.ts';
import type { SessionInfo } from './types.ts';

export const storeLimits = { conversations: 1024, metadataBytes: 4096 };
const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export class SessionStore {
  readonly #root: string;
  readonly #check: Validator<SessionInfo>;
  #creating = false;
  private constructor(root: string, check: Validator<SessionInfo>) { this.#root = root; this.#check = check; }

  static async open(root: string, schemas: Schemas): Promise<Result<SessionStore>> {
    try {
      const schema: unknown = JSON.parse(await readFile(new URL('./schema.json', import.meta.url), 'utf8'));
      if (!isObject(schema)) throw new Error('The committed session schema is invalid.');
      await mkdir(root, { recursive: true, mode: 0o700 });
      return { ok: true, value: new SessionStore(await realpath(root), schemas.compile<SessionInfo>(schema)) };
    } catch { return failure('io', 'The environment conversation state could not be opened.'); }
  }

  async list(): Promise<Result<SessionInfo[]>> {
    const names = await this.#names(); if (!names.ok) return names;
    const result: SessionInfo[] = [];
    for (const name of names.value.sort()) {
      const info = await this.info(name); if (!info.ok) return info;
      result.push(info.value);
    }
    return { ok: true, value: result };
  }

  async create(input: SessionCreateParams): Promise<Result<SessionInfo>> {
    if (this.#creating) return failure('budget', 'The environment already has an active conversation creation.');
    this.#creating = true;
    try {
      const names = await this.#names(); if (!names.ok) return names;
      if (names.value.length >= storeLimits.conversations) return failure('budget', 'The environment conversation pool is full.');
      const info = { id: randomUUID(), surface: input.surface, ...(input.project === undefined ? {} : { project: input.project }) };
      if (!this.#check(info)) return failure('invalid-args', 'The conversation metadata violates its schema.');
      const target = join(this.#root, info.id); await mkdir(target, { mode: 0o700 });
      const saved = await atomicWrite(join(target, 'metadata.json'), Buffer.from(JSON.stringify(info)));
      if (!saved.ok) { await rm(target, { recursive: true, force: true }); return saved; }
      const synced = await syncDirectory(this.#root);
      return synced.ok ? { ok: true, value: info } : synced;
    } catch { return failure('io', 'The conversation could not be created.'); }
    finally { this.#creating = false; }
  }

  async info(id: string): Promise<Result<SessionInfo>> {
    const path = await this.path(id, 'metadata.json'); if (!path.ok) return path;
    const bytes = await readBounded(path.value, storeLimits.metadataBytes); if (!bytes.ok) return bytes;
    try {
      const info: unknown = JSON.parse(bytes.value.toString('utf8'));
      return this.#check(info) && info.id === id ? { ok: true, value: info } : failure('io', 'The conversation metadata is invalid.');
    } catch { return failure('io', 'The conversation metadata could not be read.'); }
  }

  async path(id: string, name: 'metadata.json' | 'conversation.jsonl', write = false): Promise<Result<string>> {
    if (!identifier.test(id)) return failure('not-found', 'The conversation does not exist in this environment.');
    const directory = await resolvePath(id, [{ path: this.#root, mode: 'rw', space: 'state' }]); if (!directory.ok) return directory;
    return resolvePath(name, [{ path: directory.value, mode: 'rw', space: 'state' }], write);
  }

  async #names(): Promise<Result<string[]>> {
    const names: string[] = [];
    try {
      for await (const entry of await opendir(this.#root)) {
        if (!entry.isDirectory() || !identifier.test(entry.name)) return failure('io', 'The environment conversation state contains an invalid entry.');
        if (names.length >= storeLimits.conversations) return failure('budget', 'The environment conversation pool is full.');
        names.push(entry.name);
      }
      return { ok: true, value: names };
    } catch { return failure('io', 'The environment conversations could not be listed.'); }
  }
}
