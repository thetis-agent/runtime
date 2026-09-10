/** Own opaque outcome snapshots and delegate only authorized evaluation operations; EV-001–006, ADR 0014. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { Schemas } from '../schema/index.ts';
import { failure } from '../result/index.ts';
import type { Result } from '../result/index.ts';
import { snapshot } from '../snapshots/index.ts';
import { Scorer } from './scorer.ts';
import type { ScorerInput } from './scorer.ts';
import { startCandidate, turn } from './candidate.ts';
import { executionLimits } from './runtime-types.ts';
import type { ExecutionConfiguration, ExecutionHost, Frozen, Candidate } from './runtime-types.ts';
import schema from '../../contracts/evaluator/schema.json' with { type: 'json' };
import type { RunRequest, ScoreRequest, ReleaseRequest, Outcome } from '../../contracts/evaluator/types.ts';
import type { Method } from '../../contracts/kernel-socket/types.ts';
export type { ExecutionConfiguration, ExecutionHost, Candidate, Arm, TaskFixture } from './runtime-types.ts';
export const executionCapabilities = ['install.run', 'snapshot.score'];
type Operation = (run: { target: string; scope: string }, params: Record<string, unknown>) => Promise<Result<unknown>>;

export class ExecutionRuntime {
  readonly #host: ExecutionHost;
  readonly #scorer: Scorer;
  readonly #config: ExecutionConfiguration;
  readonly #snapshots = new Map<string, Frozen>();
  #active = false;
  readonly #scoring = new Set<string>();
  readonly #checks = new Map<string, { pass: boolean; exit: number | null }>();
  constructor(host: ExecutionHost, config: ExecutionConfiguration) { this.#host = host; this.#config = structuredClone(config); this.#scorer = new Scorer(host.runner, host.clock); }

  operations(schemas: Schemas): ReadonlyMap<Method, Operation> {
    schemas.compile(schema);
    const run = schemas.compile<RunRequest>({ $ref: `${schema.$id}#/$defs/runRequest` }); const score = schemas.compile<ScoreRequest>({ $ref: `${schema.$id}#/$defs/scoreRequest` }); const release = schemas.compile<ReleaseRequest>({ $ref: `${schema.$id}#/$defs/releaseRequest` });
    const authorize = (handler: (params: Record<string, unknown>) => Promise<Result<unknown>>): Operation => (source, params) => source.scope === 'deployment' && source.target === this.#config.source ? handler(params) : Promise.resolve(failure('forbidden', 'This run is not authorized for private evaluation.'));
    return new Map<Method, Operation>([
      ['install', authorize(params => run(params) ? this.run(params) : Promise.resolve(failure('invalid-args', 'The evaluation run request violates its schema.')))],
      ['snapshot', authorize(params => score(params) ? this.score(params) : Promise.resolve(failure('invalid-args', 'The evaluation score request violates its schema.')))],
      ['prune', authorize(params => release(params) ? this.release(params.id) : Promise.resolve(failure('invalid-args', 'The evaluation release request violates its schema.')))]
    ]);
  }

  async run(request: RunRequest): Promise<Result<Outcome>> {
    if (this.#active || this.#snapshots.size >= executionLimits.snapshots) return failure('budget', 'The evaluation execution pool is exhausted.');
    const expected = this.#config.startup.releases[request.pins]; const task = this.#config.startup.cases.find(entry => entry.task.id === request.task)?.task;
    if (!expected || !task || request.name !== expected.name || request.version !== expected.version || request.hash !== expected.hash) return failure('hash-mismatch', 'The evaluation arm does not match its authorized release.');
    if (request.provider !== this.#config.startup.plan.identities.provider || request.model !== this.#config.startup.plan.identities.model || request.budget.cost > task.budget.cost || request.budget.iterations > task.budget.iterations || request.withheld.tools.some(tool => task.required.includes(tool))) return failure('forbidden', 'The evaluation run changes its fixed model, budget or required tools.');
    this.#active = true; let root: string | undefined; let result: Result<Outcome>;
    try {
      await mkdir(this.#host.root, { recursive: true, mode: 0o700 }); root = await mkdtemp(join(this.#host.root, 'run-'));
      result = await this.#run(request, root);
    } catch { result = failure('io', 'The evaluation environment could not be prepared.'); }
    try { if (root) await rm(root, { recursive: true, force: true }); }
    catch {
      const released: Result<void> = result.ok ? await this.release(result.value.snapshot) : { ok: true, value: undefined };
      result = released.ok ? failure('io', 'The evaluation environment could not be removed.') : released;
    }
    finally { this.#active = false; }
    return result;
  }

  async #run(request: RunRequest, root: string): Promise<Result<Outcome>> {
    const started = await startCandidate(this.#host, this.#config, request, root); if (!started.ok) return started;
    let result: Result<Outcome>;
    try { result = await this.#capture(started.value, request, root); }
    catch { result = failure('io', 'The evaluation turn could not be captured.'); }
    const stopped = await started.value.stop('evaluation turn complete');
    if (!stopped.ok && result.ok) { const released = await this.release(result.value.snapshot); if (!released.ok) return released; }
    return stopped.ok ? result : stopped;
  }

  async #capture(candidate: Candidate, request: RunRequest, root: string): Promise<Result<Outcome>> {
    const outcome = await turn(candidate, request); if (!outcome.ok) return outcome;
    const id = randomUUID(); const path = join(this.#host.root, id);
    const frozen = await snapshot(join(root, 'space'), path); if (!frozen.ok) return frozen;
    this.#snapshots.set(id, { path, hash: frozen.value, task: request.task, mutation: request.mutation });
    return { ok: true, value: { ...outcome.value, snapshot: id } };
  }

  async score(request: ScoreRequest): Promise<Result<{ pass: boolean }>> {
    if (this.#scoring.has(request.snapshot)) return failure('switching', 'The evaluation snapshot is already being scored.');
    this.#scoring.add(request.snapshot);
    try { return await this.#score(request); }
    catch { return failure('io', 'The evaluation snapshot could not be scored.'); }
    finally { this.#scoring.delete(request.snapshot); }
  }

  async #score(request: ScoreRequest): Promise<Result<{ pass: boolean }>> {
    const frozen = this.#snapshots.get(request.snapshot); const check = frozen && this.#config.fixtures[frozen.task]?.checks[request.scorer];
    if (!frozen || !check || request.target !== request.snapshot) return failure('forbidden', 'The score request has no authorized frozen snapshot or scorer.');
    const code = await snapshot(dirname(check.path)); if (!code.ok) return code;
    if (code.value !== check.hash) return failure('hash-mismatch', 'The outcome check does not match its authorized hash.');
    const state = await snapshot(frozen.path); if (!state.ok) return state;
    if (state.value !== frozen.hash) return failure('hash-mismatch', 'The frozen outcome snapshot changed before scoring.');
    const key = createHash('sha256').update(JSON.stringify([check.hash, basename(check.path), frozen.hash, Object.entries(frozen.mutation).sort(([a], [b]) => a.localeCompare(b))])).digest('hex');
    const cached = this.#checks.get(key);
    if (cached) {
      const observed = await this.#host.observe('evaluation.outcome', { snapshot: request.snapshot, scorer: request.scorer, ...cached, cached: true });
      return observed.ok ? { ok: true, value: { pass: cached.pass } } : observed;
    }
    return await this.#checked(request, frozen, check, key);
  }

  async #checked(request: ScoreRequest, frozen: Frozen, check: { path: string; hash: string }, key: string): Promise<Result<{ pass: boolean }>> {
    const authority = await this.#host.authority(); if (!authority.ok) return authority;
    let result: Result<{ pass: boolean }>;
    try {
      const scored = await this.#isolated({ checks: check.path, snapshot: frozen.path, replacements: frozen.mutation, authority: authority.value }, check.hash);
      if (!scored.ok) result = scored;
      else {
        const observed = await this.#host.observe('evaluation.outcome', { snapshot: request.snapshot, scorer: request.scorer, exit: scored.value.exit, pass: scored.value.pass });
        if (observed.ok) {
          if (this.#checks.size >= executionLimits.checks) { const oldest = this.#checks.keys().next().value; if (oldest) this.#checks.delete(oldest); }
          this.#checks.set(key, { pass: scored.value.pass, exit: scored.value.exit });
        }
        result = observed.ok ? { ok: true, value: { pass: scored.value.pass } } : observed;
      }
    } catch { result = failure('io', 'The outcome check failed.'); }
    const closed = await authority.value.close(); return closed.ok ? result : closed;
  }

  async #isolated(input: ScorerInput, hash: string): Promise<Result<{ pass: boolean; exit: number | null }>> {
    const path = join(this.#host.root, `check-${randomUUID()}`); let result: Result<{ pass: boolean; exit: number | null }>;
    try {
      const copy = await snapshot(dirname(input.checks), path);
      result = !copy.ok ? copy : copy.value !== hash ? failure('hash-mismatch', 'The outcome check changed while it was copied.')
        : await this.#scorer.run({ ...input, checks: join(path, basename(input.checks)) });
    } catch { result = failure('io', 'The private outcome check could not be copied.'); }
    try { await rm(path, { recursive: true, force: true }); }
    catch { return failure('io', 'The private outcome check could not be removed.'); }
    return result;
  }

  async close(): Promise<Result<void>> {
    if (this.#active || this.#scoring.size) return failure('switching', 'Evaluation execution is still active.');
    for (const id of this.#snapshots.keys()) { const released = await this.release(id); if (!released.ok) return released; }
    this.#checks.clear(); return { ok: true, value: undefined };
  }

  async release(id: string): Promise<Result<void>> {
    if (this.#scoring.has(id)) return failure('switching', 'The evaluation snapshot is being scored.');
    const value = this.#snapshots.get(id); if (!value) return failure('not-found', 'The evaluation snapshot does not exist.');
    try { await rm(value.path, { recursive: true, force: true }); this.#snapshots.delete(id); return { ok: true, value: undefined }; }
    catch { return failure('io', 'The evaluation snapshot could not be released.'); }
  }
}
