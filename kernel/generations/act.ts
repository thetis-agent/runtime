/** Bind the sole default act to a reviewer, origin, immutable evidence and baseline; KS-014–016, ADR 0018. */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWrite } from '../../lib/files/atomic.ts';
import type { Principal, Run } from '../identity/index.ts';
import type { Journal } from '../log/index.ts';
import type { DefaultPrepareParams, DefaultSetParams } from '../../contracts/kernel-socket/types.ts';
import type { Schemas, Result } from '../../lib/schema/index.ts';
import { failure } from '../../lib/schema/index.ts';
import { validators } from '../../lib/evaluation/index.ts';
import type { Plan, Submission } from '../../lib/evaluation/index.ts';

export const actLimits = { plans: 256, codes: 256, codeMs: 600000, submissionBytes: 1024 * 1024 };
interface Evidence { source: string; plan: Plan; submission?: Submission; passed?: boolean }
const key = (digest: string, baseline: string | number): string => JSON.stringify([digest, String(baseline)]);
interface Confirmation { person: string; digest: string; baseline: number; expires: number }
export interface ActContext {
  root: string;
  journal: Journal; schemas: Schemas; now(): number; baseline(): number;
  evaluate(submission: Submission, plan: Plan): Promise<Result<{ passed: boolean }>>;
  commit(digest: string, baseline: number): Promise<Result<void>>;
}

export class Act {
  readonly #context: ActContext;
  readonly #evidence = new Map<string, Evidence>();
  readonly #pending = new Set<string>();
  readonly #codes = new Map<string, Confirmation>();
  readonly #check: ReturnType<typeof validators>;
  #busy = false;
  constructor(context: ActContext) { this.#context = context; this.#check = validators(context.schemas); }

  authorize(person: Principal, source: string, input: unknown): Result<void> {
    if (person.role !== 'admin') return failure('forbidden', 'Only an administrator can designate evaluation evidence.');
    if (!this.#check.plan(input)) return failure('invalid-args', 'The evaluation plan violates its schema.');
    if (this.#evidence.has(key(input.identities.candidate, input.identities.baseline))) return failure('invalid-args', 'The evaluation plan is already immutable.');
    if (this.#evidence.size >= actLimits.plans) return failure('budget', 'The evaluation plan pool is full.');
    this.#evidence.set(key(input.identities.candidate, input.identities.baseline), { source, plan: structuredClone(input) });
    return { ok: true, value: undefined };
  }

  async submit(run: Run, input: unknown): Promise<Result<{ stale: boolean }>> {
    if (!this.#check.submission(input) || Buffer.byteLength(JSON.stringify(input)) > actLimits.submissionBytes) return failure('invalid-args', 'The evaluation submission violates its schema or byte limit.');
    const identity = key(input.identities.candidate, input.identities.baseline);
    const evidence = this.#evidence.get(identity);
    if (!evidence || run.scope !== 'deployment' || run.target !== evidence.source) return failure('forbidden', 'This run is not designated for that evaluation.');
    if (Object.entries(evidence.plan.identities).some(([key, value]) => input.identities[key] !== value)) return failure('invalid-args', 'The evaluation identities do not match the authorized plan.');
    if (this.#pending.has(identity) || evidence.submission) return failure('conflict', 'The evaluation evidence is already submitted or being committed.');
    this.#pending.add(identity);
    try { return await this.#store(evidence, structuredClone(input)); } finally { this.#pending.delete(identity); }
  }

  async #store(evidence: Evidence, value: Submission): Promise<Result<{ stale: boolean }>> {
    const assessed = await this.#context.evaluate(value, evidence.plan); if (!assessed.ok) return assessed;
    const stale = value.identities.baseline !== String(this.#context.baseline());
    const path = join(this.#context.root, `${createHash('sha256').update(JSON.stringify(value.identities)).digest('hex')}.json`);
    const stored = await atomicWrite(path, Buffer.from(JSON.stringify({ source: evidence.source, plan: evidence.plan, submission: value, stale })));
    if (!stored.ok) return stored;
    const written = await this.#context.journal.observed('default', 'results.accepted', { identities: value.identities, passed: assessed.value.passed, stale });
    if (!written.ok) return written;
    evidence.submission = value; evidence.passed = assessed.value.passed;
    return { ok: true, value: { stale } };
  }

  prepare(person: Principal, origin: 'kernel' | 'package', params: DefaultPrepareParams): Result<{ code: string; line: string }> {
    const valid = this.#guard(person, origin, params); if (!valid.ok) return valid;
    for (const [code, value] of this.#codes) if (value.expires <= this.#context.now()) this.#codes.delete(code);
    if (this.#codes.size >= actLimits.codes) return failure('budget', 'The confirmation code pool is full.');
    const code = randomBytes(24).toString('base64url');
    this.#codes.set(code, { person: person.id, digest: params.digest, baseline: params.baseline, expires: this.#context.now() + actLimits.codeMs });
    return { ok: true, value: { code, line: `${params.digest} baseline ${String(params.baseline)} gate passed code ${code}` } };
  }

  async set(person: Principal, origin: 'kernel' | 'package', params: DefaultSetParams): Promise<Result<void>> {
    const valid = this.#guard(person, origin, params); if (!valid.ok) return valid;
    const confirmation = this.#codes.get(params.code);
    if (!confirmation || confirmation.expires <= this.#context.now() || confirmation.person !== person.id || confirmation.digest !== params.digest || confirmation.baseline !== params.baseline) return failure('forbidden', 'The confirmation code does not authorize this act.');
    if (this.#busy) return failure('baseline-moved', 'The default baseline is being moved; prepare again.');
    this.#busy = true; this.#codes.delete(params.code);
    try {
      const committed = await this.#context.commit(params.digest, params.baseline);
      if (!committed.ok) return committed;
      return await this.#context.journal.observed('default', 'default.set', { digest: params.digest, baseline: params.baseline, person: person.id });
    } finally { this.#busy = false; }
  }

  #guard(person: Principal, origin: 'kernel' | 'package', params: DefaultPrepareParams): Result<void> {
    if (origin !== 'kernel' || person.role === 'user') return failure('forbidden', 'The default act requires a reviewer at the kernel origin.');
    if (params.baseline !== this.#context.baseline()) return failure('baseline-moved', 'The default baseline moved; prepare again.');
    const evidence = this.#evidence.get(key(params.digest, params.baseline));
    if (!evidence?.submission || evidence.plan.identities.baseline !== String(params.baseline) || evidence.passed !== true) return failure('forbidden', 'The release has no current passing evaluation.');
    return { ok: true, value: undefined };
  }
}
