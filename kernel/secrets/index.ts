/** Keep scoped secrets encrypted and deny package-origin writes; ADR 0009, ADR 0019, KS-008. */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../../lib/files/atomic.ts';
import { readBounded } from '../../lib/files/read-bounded.ts';
import { failure, isObject } from '../../lib/schema/index.ts';
import type { Result } from '../../lib/schema/index.ts';
import type { Principal } from '../identity/index.ts';
import type { SecretSetParams } from '../../contracts/kernel-socket/types.ts';

export const limits = { entries: 4096, valueBytes: 16384, nameBytes: 256, grantNames: 64 };
type Code = 'forbidden' | 'invalid-args' | 'budget' | 'io' | 'unbound';
const identifier = (scope: string, name: string) => createHash('sha256').update(JSON.stringify([scope, name])).digest('hex');
const valid = (scope: string, name: string) => /^(deployment|(?:person|project)\/[^/\0]+)$/u.test(scope) && name.length > 0 && Buffer.byteLength(name) <= limits.nameBytes && !name.includes('\0');

export class Secrets {
  readonly #root: string;
  readonly #key: Uint8Array;
  readonly #known: Set<string>;
  readonly #grants = new Map<string, { scope: string; names: readonly string[] }>();
  #busy = false;
  private constructor(root: string, key: Uint8Array, names: string[]) { this.#root = root; this.#key = Uint8Array.from(key); this.#known = new Set(names); }

  static async open(root: string, key: Uint8Array): Promise<Result<Secrets, Code>> {
    if (key.length !== 32) return failure('invalid-args', 'The secret store requires a 32-byte encryption key.');
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const entries = await readdir(root); const names = entries.filter(name => name.endsWith('.sealed'));
      if (entries.length > limits.entries) return failure('budget', 'The secret store pool is full.');
      return { ok: true, value: new Secrets(root, key, names) };
    } catch { return failure('io', 'The secret store could not be opened.'); }
  }

  async set(person: Principal, origin: 'kernel' | 'package', params: SecretSetParams): Promise<Result<void, Code>> {
    if (origin !== 'kernel' || person.role !== 'admin' && params.scope !== `person/${person.id}`) return failure('forbidden', 'This origin or person cannot set that secret scope.');
    if (!valid(params.scope, params.name)) return failure('invalid-args', 'The secret scope or name is invalid.');
    if (Buffer.byteLength(params.value) > limits.valueBytes || Buffer.byteLength(params.scope) > limits.nameBytes) return failure('budget', 'The secret exceeds its storage budget.');
    const name = `${identifier(params.scope, params.name)}.sealed`;
    if (this.#busy || !this.#known.has(name) && this.#known.size >= limits.entries) return failure('budget', 'The secret store writer or pool is full.');
    const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(Buffer.from(name));
    const ciphertext = Buffer.concat([cipher.update(params.value, 'utf8'), cipher.final()]);
    const envelope = JSON.stringify({ nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
    this.#busy = true;
    try {
      const result = await atomicWrite(join(this.#root, name), Buffer.from(envelope));
      if (result.ok) this.#known.add(name);
      return result;
    } finally { this.#busy = false; }
  }

  has(name: string, scopes: readonly string[]): boolean { return scopes.some(scope => this.#known.has(`${identifier(scope, name)}.sealed`)); }

  register(spawn: string, scope: string, names: readonly string[]): Result<void, Code> {
    if (names.length > limits.grantNames || Buffer.byteLength(scope) > limits.nameBytes || !names.every(name => valid(scope, name))) return failure('invalid-args', 'The spawn secret grant is invalid.');
    if (this.#grants.size >= limits.entries && !this.#grants.has(spawn)) return failure('budget', 'The secret grant pool is full.');
    this.#grants.set(spawn, { scope, names: [...names] }); return { ok: true, value: undefined };
  }

  revoke(spawn: string): void { this.#grants.delete(spawn); }

  async deliver(spawn: string, name: string): Promise<Result<Uint8Array, Code>> {
    const grant = this.#grants.get(spawn);
    if (!grant?.names.includes(name)) return failure('forbidden', 'The spawn is not registered for that secret.');
    const file = `${identifier(grant.scope, name)}.sealed`;
    if (!this.#known.has(file)) return failure('unbound', `The secret ${name} is absent in ${grant.scope}.`);
    try {
      const bytes = await readBounded(join(this.#root, file), limits.valueBytes * 2);
      if (!bytes.ok) return bytes;
      const envelope: unknown = JSON.parse(bytes.value.toString('utf8'));
      if (!isObject(envelope) || typeof envelope['nonce'] !== 'string' || typeof envelope['tag'] !== 'string' || typeof envelope['ciphertext'] !== 'string') return failure('io', 'The sealed secret is invalid.');
      const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(envelope['nonce'], 'base64'));
      decipher.setAAD(Buffer.from(file)); decipher.setAuthTag(Buffer.from(envelope['tag'], 'base64'));
      return { ok: true, value: Buffer.concat([decipher.update(Buffer.from(envelope['ciphertext'], 'base64')), decipher.final()]) };
    } catch { return failure('io', 'The selected secret could not be decrypted; no other scope was tried.'); }
  }
}
