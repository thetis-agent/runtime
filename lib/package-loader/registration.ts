/** Apply the same envelope to exported and initialized spawns; ADR 0016 §3, KS-009. */
import type { Validator as ValidateFunction } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import { failure } from '@/lib/schema/index.ts';
import { envelope } from '@/lib/semver-match/index.ts';
import type { Entry, Registration } from './types.ts';

type Registered = Result<Registration | undefined, 'envelope' | 'invalid-args'>;
export class Register {
  readonly #entry: Entry;
  readonly #check: ValidateFunction<Registration>;
  #value: Registered = { ok: true, value: undefined };
  #registered = false;
  constructor(entry: Entry, check: ValidateFunction<Registration>) { this.#entry = entry; this.#check = check; }

  register(value: unknown): Result<void, 'envelope' | 'invalid-args'> {
    if (this.#registered) { this.#value = failure('envelope', `${this.#entry.manifest.name} registered more than once.`); return this.#value; }
    this.#registered = true; this.#value = this.#validate(value);
    return this.#value.ok ? { ok: true, value: undefined } : this.#value;
  }

  finish(spawn: unknown): Registered {
    if (!this.#value.ok || spawn === undefined) return this.#value;
    if (!Array.isArray(spawn)) return failure('invalid-args', `${this.#entry.manifest.name} exports an invalid spawn list.`);
    const exported: unknown[] = spawn;
    return this.#validate({ requires: {}, provides: {}, ...this.#value.value, spawn: [...exported, ...(this.#value.value?.spawn ?? [])] });
  }

  #validate(value: unknown): Registered {
    const manifest = this.#entry.manifest; const source = `${manifest.name}@${manifest.version}`;
    if (!this.#check(value)) return failure('invalid-args', `${source} registered an invalid shape.`);
    const requires = envelope(Object.keys(value.requires), manifest.envelope.requires); const provides = envelope(Object.keys(value.provides), manifest.envelope.provides);
    if (!requires.ok) return requires; if (!provides.ok) return provides;
    const spawns = value.spawn ?? [];
    if (new Set(spawns.map(spawn => spawn.id)).size !== spawns.length) return failure('invalid-args', `${source} registered duplicate spawn ids.`);
    for (const spawn of spawns) {
      if (spawn.scope !== manifest.envelope.spawn.scope || spawn.network !== manifest.envelope.spawn.network) return failure('envelope', `${source} registered a spawn outside its envelope.`);
      for (const reference of Object.values(spawn.env ?? {})) if (reference.startsWith('secret/') && !(reference in manifest.requires) && !(reference in value.requires)) return failure('envelope', `${source} delivers an undeclared secret requirement.`);
    }
    return { ok: true, value: structuredClone(value) };
  }
}
