/** Bind evidence and every delegated descriptor to one fenced run principal; KS-006–008, ADR 0021. */
import { createHash, randomBytes } from 'node:crypto';
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';

export type Role = 'admin' | 'reviewer' | 'user';
export interface Principal { id: string; role: Role; projects: readonly string[]; observeOthers: boolean }
export interface Run {
  id: string; person: string; scope: 'person' | 'deployment'; target: string;
  generation: number; expires: number; services: readonly string[]; cost?: number;
}
export interface IdentityConfig {
  people: readonly Principal[];
  bindings: readonly { kind: string; id: string; person: string }[];
  authorities: Readonly<Record<string, string>>;
  tokens?: number; tokenLifetimeMs?: number;
}
type ErrorCode = 'auth' | 'forbidden' | 'unbound' | 'fenced' | 'budget';
const digest = (token: string): string => createHash('sha256').update(token).digest('hex');

export class Identity {
  readonly #people: Map<string, Principal>;
  readonly #bindings = new Map<string, string>();
  readonly #tokens = new Map<string, Run>();
  readonly #generations = new Map<string, number>();
  readonly #pending = new Map<string, string>();
  readonly #probeOnly = new Set<string>();
  readonly #sessions = new Map<string, { person: string; expires: number }>();
  readonly #config: IdentityConfig;
  readonly #now: () => number;

  constructor(config: IdentityConfig, now: () => number) {
    this.#config = structuredClone(config); this.#now = now;
    this.#people = new Map(config.people.map(person => [person.id, structuredClone(person)]));
    for (const binding of config.bindings) this.#bindings.set(JSON.stringify([binding.kind, binding.id]), binding.person);
  }

  assert(authority: string, kind: string, id: string): Result<Principal, ErrorCode> {
    if (this.#config.authorities[kind] !== authority) return failure('forbidden', `This authority cannot assert ${kind}.`);
    const person = this.#bindings.get(JSON.stringify([kind, id]));
    const principal = person === undefined ? undefined : this.#people.get(person);
    return principal ? { ok: true, value: structuredClone(principal) } : failure('unbound', `The ${kind} identity has no binding.`);
  }

  session(authority: string, kind: string, id: string): Result<{ sessionToken: string; person: string; role: Role }, ErrorCode> {
    const principal = this.assert(authority, kind, id); if (!principal.ok) return principal;
    for (const [key, session] of this.#sessions) if (session.expires <= this.#now()) this.#sessions.delete(key);
    if (this.#sessions.size >= (this.#config.tokens ?? 4096)) return failure('budget', 'The identity session pool is full.');
    const token = randomBytes(32).toString('base64url');
    this.#sessions.set(digest(token), { person: principal.value.id, expires: this.#now() + (this.#config.tokenLifetimeMs ?? 86400000) });
    return { ok: true, value: { sessionToken: token, person: principal.value.id, role: principal.value.role } };
  }

  resolveSession(token: string): Result<Principal, ErrorCode> {
    const session = this.#sessions.get(digest(token));
    if (!session || session.expires <= this.#now()) return failure('auth', 'The identity session is unknown or expired.');
    const person = this.#people.get(session.person);
    return person ? { ok: true, value: structuredClone(person) } : failure('unbound', 'The identity session has no principal.');
  }

  issue(run: Omit<Run, 'expires'>): Result<string, ErrorCode> {
    const generation = this.#generations.get(run.target);
    if (generation !== undefined && run.generation !== generation) return failure('fenced', 'The run generation is no longer current.');
    if (generation === undefined && this.#generations.size >= (this.#config.tokens ?? 4096)) return failure('budget', 'The generation identity pool is full.');
    const result = this.#mint(run); if (result.ok) this.#generations.set(run.target, run.generation); return result;
  }

  stage(run: Omit<Run, 'expires'>): Result<string, ErrorCode> {
    this.#reap(); const current = this.#generations.get(run.target);
    if (current === undefined || run.generation !== current + 1 || this.#pending.has(run.target)) return failure('fenced', 'The target cannot admit this provisional generation.');
    const result = this.#mint(run);
    if (result.ok) { const key = digest(result.value); this.#pending.set(run.target, key); this.#probeOnly.add(key); }
    return result;
  }

  authenticate(token: string, purpose: 'call' | 'probe' = 'call'): Result<Run, ErrorCode> {
    const key = digest(token); const run = this.#tokens.get(key);
    if (!run || run.expires <= this.#now()) return failure('auth', 'The run credential is unknown or expired.');
    if (purpose === 'call' && this.#probeOnly.has(key)) return failure('fenced', 'A provisional credential cannot admit ordinary calls.');
    if (this.#generations.get(run.target) !== run.generation && !(purpose === 'probe' && this.#pending.get(run.target) === key)) return failure('fenced', 'The run generation has been fenced.');
    return { ok: true, value: structuredClone(run) };
  }

  access(token: string, owner: string, observe = false): Result<Run, ErrorCode> {
    const run = this.authenticate(token);
    if (!run.ok) return run;
    if (run.value.scope !== 'person') return failure('forbidden', 'A service must resolve a person before accessing conversations.');
    const person = this.#people.get(run.value.person);
    if (run.value.person !== owner && !(observe && person?.observeOthers)) return failure('forbidden', 'The conversation belongs to another person.');
    return run;
  }

  whois(serviceToken: string, callerToken: string): Result<Run, ErrorCode> {
    const service = this.authenticate(serviceToken);
    if (!service.ok) return service;
    const caller = this.authenticate(callerToken); if (!caller.ok) return caller;
    if (service.value.scope !== 'deployment' && (service.value.id !== caller.value.id || service.value.person !== caller.value.person || service.value.target !== caller.value.target || service.value.generation !== caller.value.generation)) return failure('forbidden', 'Only a deployment service can resolve another run.');
    return caller;
  }

  fence(target: string, generation: number): void {
    const current = this.#generations.get(target);
    if (current !== undefined && generation <= current) throw new Error('Generation fencing must advance.');
    this.#generations.set(target, generation);
    this.#pending.delete(target);
  }

  revoke(token: string): void { this.#remove(digest(token)); }

  /** Release only a runtime-owned, never-reused ephemeral target; persistent fencing survives ordinary revocation. */
  retire(target: string): void {
    for (const [key, run] of this.#tokens) if (run.target === target) this.#remove(key);
    this.#pending.delete(target); this.#generations.delete(target);
  }

  principal(id: string): Principal | undefined {
    const person = this.#people.get(id);
    return person ? structuredClone(person) : undefined;
  }

  #reap(): void {
    for (const [key, run] of this.#tokens) if (run.expires <= this.#now()) this.#remove(key);
  }

  #remove(key: string): void {
    const run = this.#tokens.get(key);
    if (run && this.#pending.get(run.target) === key) this.#pending.delete(run.target);
    this.#tokens.delete(key);
    this.#probeOnly.delete(key);
  }

  #mint(run: Omit<Run, 'expires'>): Result<string, ErrorCode> {
    this.#reap();
    if (run.cost !== undefined && (!Number.isFinite(run.cost) || run.cost < 0) || run.person.includes('\0')) return failure('budget', 'The run cost boundary or principal is invalid.');
    if (this.#tokens.size >= (this.#config.tokens ?? 4096)) return failure('budget', 'The run token pool is full.');
    if (!(run.scope === 'deployment' && run.person === '') && !this.#people.has(run.person)) return failure('unbound', 'The run principal does not exist.');
    const token = randomBytes(32).toString('base64url');
    this.#tokens.set(digest(token), { ...structuredClone(run), expires: this.#now() + (this.#config.tokenLifetimeMs ?? 86400000) });
    return { ok: true, value: token };
  }
}
