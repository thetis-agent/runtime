/** Keep scoped secrets encrypted and deny package-origin writes; ADR 0009, ADR 0019, KS-008. */
import { createHash } from 'node:crypto';
import { storage } from '../../lib/storage/index.ts';
import type { Storage } from '../../contracts/storage/index.ts';
import { seal, unseal } from '../../lib/files/sealed.ts';
import { failure } from '../../lib/schema/index.ts';
import type { Result } from '../../lib/schema/index.ts';
import type { Principal } from '../identity/index.ts';
import type { SecretSetParams } from '../../contracts/kernel-socket/types.ts';

export const limits = { entries: 4096, valueBytes: 16384, nameBytes: 256, grantNames: 64 };
type Code = 'forbidden' | 'invalid-args' | 'budget' | 'io' | 'unbound';
const identifier = (scope: string, name: string) => createHash('sha256').update(JSON.stringify([scope, name])).digest('hex');
const valid = (scope: string, name: string) => /^(deployment|(?:person|project)\/[^/\0]+)$/u.test(scope) && name.length > 0 && Buffer.byteLength(name) <= limits.nameBytes && !name.includes('\0');

export class Secrets {
  readonly #store: Storage;
  readonly #key: Uint8Array;
  readonly #grants = new Map<string, { scope: string; names: readonly string[] }>();
  private constructor(store: Storage, key: Uint8Array) { this.#store = store; this.#key = Uint8Array.from(key); }

  static async open(root: string, key: Uint8Array): Promise<Result<Secrets, Code>> {
    if (key.length !== 32) return failure('invalid-args', 'The secret store requires a 32-byte encryption key.');
    const opened = await storage.open(root, { entries: limits.entries, valueBytes: limits.valueBytes * 2, bytes: limits.entries * limits.valueBytes * 2 });
    return opened.ok ? { ok: true, value: new Secrets(opened.value, key) } : opened;
  }

  async set(person: Principal, origin: 'kernel' | 'package', params: SecretSetParams): Promise<Result<void, Code>> {
    if (origin !== 'kernel' || person.role !== 'admin' && params.scope !== `person/${person.id}`) return failure('forbidden', 'This origin or person cannot set that secret scope.');
    if (!valid(params.scope, params.name)) return failure('invalid-args', 'The secret scope or name is invalid.');
    if (Buffer.byteLength(params.value) > limits.valueBytes || Buffer.byteLength(params.scope) > limits.nameBytes) return failure('budget', 'The secret exceeds its storage budget.');
    const name = `${identifier(params.scope, params.name)}.sealed`;
    const envelope = seal(this.#key, name, params.value); if (!envelope.ok) return envelope;
    return this.#store.put(name, envelope.value);
  }

  has(name: string, scopes: readonly string[]): boolean { return scopes.some(scope => this.#store.has(`${identifier(scope, name)}.sealed`)); }

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
    if (!this.#store.has(file)) return failure('unbound', `The secret ${name} is absent in ${grant.scope}.`);
    const bytes = await this.#store.get(file);
    if (!bytes.ok) return failure(bytes.error.code === 'budget' ? 'budget' : 'io', 'The selected secret could not be read; no other scope was tried.');
    const opened = unseal(this.#key, file, bytes.value);
    return opened.ok ? opened : failure('io', opened.error.code === 'invalid-args' ? 'The sealed secret is invalid.' : 'The selected secret could not be decrypted; no other scope was tried.');
  }
}
