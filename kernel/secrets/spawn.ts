/** Deliver only the declared spawn's selected secret scope, never settings values; ADR 0009, ADR 0019. */
import { Register } from '../../lib/package-loader/registration.ts';
import { validator } from '../../lib/package-loader/index.ts';
import type { Entry, Registration, Spawn } from '../../lib/package-loader/types.ts';
import { failure } from '../../lib/schema/index.ts';
import type { Result, Schemas } from '../../lib/schema/index.ts';
import type { Secrets } from './index.ts';
import { gap } from '../../lib/semver-match/index.ts';

export async function declaration(entry: Entry, input: Record<string, unknown>, schemas: Schemas): Promise<Result<Spawn>> {
  const check = await validator<Registration>(schemas, 'registration'); const register = new Register(entry, check);
  const accepted = register.register({ requires: input['requires'] ?? {}, provides: input['provides'] ?? {}, spawn: [input['declared']] });
  if (!accepted.ok) return accepted;
  const result = register.finish(undefined); if (!result.ok) return result;
  const spawn = result.value?.spawn?.[0];
  return spawn && spawn.id === input['id'] ? { ok: true, value: spawn } : failure('envelope', 'The target has no matching declared spawn.');
}

export async function deliver(store: Secrets | undefined, target: string, scope: string, spawn: Spawn, pkg: Pick<Entry['manifest'], 'name' | 'version' | 'requires'>): Promise<Result<Record<string, string>>> {
  const references = Object.entries(spawn.env ?? {}); const values: Record<string, string> = {};
  if (!references.length) return { ok: true, value: values };
  const names = references.map(([, reference]) => reference.slice('secret/'.length));
  if (references.some(([, reference]) => !reference.startsWith('secret/'))) return failure('envelope', 'The spawn environment contains an undeclared non-secret value.');
  const missing = (reference: string) => failure('gap', gap(pkg, reference, pkg.requires[reference] ?? '*'));
  if (!store) return missing(references[0]?.[1] ?? 'secret/unknown');
  const registered = store.register(target, scope, names); if (!registered.ok) return registered;
  try {
    for (const [name, reference] of references) {
      const value = await store.deliver(target, reference.slice('secret/'.length)); if (!value.ok) return value.error.code === 'unbound' ? missing(reference) : value;
      values[name] = Buffer.from(value.value).toString('utf8');
    }
    return { ok: true, value: values };
  } finally { store.revoke(target); }
}
