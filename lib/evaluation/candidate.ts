/** Give a clean candidate only verified code and a mutated fixture copy; EV-002, ADR 0004 §3. */
import { realpath, mkdir } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { snapshot } from '../snapshots/index.ts';
import { failure, isObject } from '../result/index.ts';
import type { Result } from '../result/index.ts';
import type { Arm, ExecutionConfiguration, ExecutionHost, Candidate } from './runtime-types.ts';
import type { Mount } from '../sandbox-runner/index.ts';
import type { Setup } from '../package-loader/types.ts';
import { executionLimits } from './runtime-types.ts';
import { fixture } from './fixture.ts';
import type { TurnJob, Outcome } from './types.ts';

function within(root: string, path: string): boolean { const child = relative(root, path); return child === '' || child !== '..' && !child.startsWith('../') && !isAbsolute(child); }

async function verify(arm: Arm, privateRoots: readonly string[]): Promise<Result<void>> {
  const roots = await Promise.all(privateRoots.map(root => realpath(root)));
  if (arm.plan.secrets && Object.keys(arm.plan.secrets).length) return failure('forbidden', 'A candidate cannot receive evaluator secrets.');
  for (const mount of arm.plan.mounts) {
    const source = await realpath(mount.source);
    if (mount.mode !== 'ro' || roots.some(root => within(root, source) || within(source, root))) return failure('outside-roots', 'A candidate mount overlaps private evaluation data or grants shared writes.');
  }
  for (const pin of Object.values(arm.pins)) {
    const actual = await snapshot(pin.source); if (!actual.ok) return actual;
    if (actual.value !== pin.hash) return failure('hash-mismatch', 'The candidate code does not match its authorized pin.');
  }
  return { ok: true, value: undefined };
}

async function copiedPins(arm: Arm, root: string): Promise<Result<Mount[]>> {
  if (!Object.keys(arm.pins).length) return failure('hash-mismatch', 'The candidate has no authorized code pins.');
  const copies = new Map<string, string>();
  for (const [index, pin] of Object.values(arm.pins).entries()) {
    const source = await realpath(pin.source); const destination = join(root, `code-${String(index)}`);
    const copied = await snapshot(source, destination); if (!copied.ok) return copied;
    if (copied.value !== pin.hash) return failure('hash-mismatch', 'The copied candidate code changed from its pin.');
    copies.set(source, destination);
  }
  const mounts: Mount[] = []; const pinned: string[] = [];
  for (const mount of arm.plan.mounts) {
    const source = await realpath(mount.source); const copy = copies.get(source);
    if (copy) pinned.push(mount.path);
    mounts.push(copy ? { ...mount, source: copy } : mount);
  }
  if (![arm.plan.entry, ...arm.setup.entries.map(entry => entry.path)].every(path => pinned.some(root => within(root, path)))) return failure('hash-mismatch', 'Every candidate entry must be covered by a copied code pin.');
  return { ok: true, value: mounts };
}

export async function startCandidate(host: ExecutionHost, config: ExecutionConfiguration, job: TurnJob, root: string): Promise<Result<Candidate>> {
  const arm = config.arms[job.pins]; const task = config.fixtures[job.task];
  if (!arm?.setup.runtime || !task) return failure('not-found', 'The evaluation task or arm is not authorized.');
  const verified = await verify(arm, config.privateRoots); if (!verified.ok) return verified;
  const pins = await copiedPins(arm, root); if (!pins.ok) return pins;
  const space = join(root, 'space'); const copied = await fixture(task.source, task.hash, space, job.mutation); if (!copied.ok) return copied;
  await mkdir(join(root, 'state'), { mode: 0o700 });
  const setup = structuredClone(arm.setup); const runtime = setup.runtime;
  if (!runtime) throw new Error('The verified candidate lost its runtime.');
  const roots: Setup['spaces'] = [{ path: '/space', mode: 'rw', space: 'person' }];
  setup.spaces = roots; runtime.root = '/state/conversations'; runtime.space = '/space'; runtime.roots = roots;
  runtime.excludedSkills = [...new Set([...(runtime.excludedSkills ?? []), ...job.withheld.skills])];
  runtime.maxIterations = Math.min(runtime.maxIterations ?? job.budget.iterations, job.budget.iterations);
  runtime.provider = job.provider; runtime.model = job.model; runtime.modelOptions = { ...runtime.modelOptions, seed: job.modelSeed };
  runtime.mode.deny = [...new Set([...runtime.mode.deny, ...job.withheld.tools.map(name => name.split('/').at(-1)?.split('@')[0] ?? name)])];
  return host.launch({ ...arm.plan, mounts: [...pins.value, ...['state', 'space'].map((name): Mount => ({ source: join(root, name), path: `/${name}`, mode: 'rw', maximumBytes: executionLimits.quotaBytes }))] }, setup, { cost: job.budget.cost });
}

export async function turn(candidate: Candidate, job: TurnJob): Promise<Result<Pick<Outcome, 'iterations' | 'cost' | 'counters' | 'dropped' | 'end'>>> {
  const probe = await candidate.probe(); if (!probe.ok) return probe;
  const created = await candidate.invoke('session.create', { surface: 'surface' }); if (!created.ok) return created;
  if (!isObject(created.value) || typeof created.value['id'] !== 'string') return failure('invalid-args', 'The candidate returned no conversation identity.');
  const submitted = await candidate.invoke('session.submit', { conversation: created.value['id'], input: job.input });
  const frozen = await candidate.freeze(); if (!frozen.ok) return frozen;
  const facts = await candidate.facts(); if (!facts.ok) return facts;
  return { ok: true, value: { ...facts.value, cost: facts.value.counters['cost'] ?? 0, end: submitted.ok ? facts.value.end : { reason: 'crash' } } };
}
