/** Bind the default act to a frozen multi-target transaction and immutable authorized evidence; GN-005, KS-015. */
import { join } from 'node:path';
import { Act } from '@/kernel/generations/act.ts';
import { Generations } from '@/kernel/generations/index.ts';
import type { Input, View } from '@/kernel/generations/index.ts';
import type { Runtime, Target } from '@/kernel/boundary/runtime.ts';
import type { Principal } from '@/kernel/identity/index.ts';
import type { Journal } from '@/kernel/log/index.ts';
import type { Schemas, Result } from '@/lib/schema/index.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Trusted } from '@/lib/deployment/types.ts';
import { manifestSnapshot } from '@/lib/deployment/snapshot.ts';
import { atomicWrite } from '@/lib/files/atomic.ts';
import { calculate } from '@/lib/evaluation/index.ts';

export type DefaultSettings = Pick<Trusted, 'baseline' | 'digest' | 'plans'> & { releases: readonly { digest: string; targets: readonly Target[] }[] };
export interface DefaultContext { root: string; schemas: Schemas; journal: Journal; runtime: Runtime; administrator: Principal; now(): number }
export async function defaultAct(context: DefaultContext, trusted: DefaultSettings, recovered?: View): Promise<Result<{ act: Act; machine: Generations; ready(): Promise<Result<void>> }>> {
  const machine = new Generations('default', { n: trusted.baseline, pins: { release: trusted.digest }, stateSnapshot: '', prefixRenderer: '1', at: context.now() }, context.journal, () => context.now(), undefined, recovered);
  const moved = async (input: Input): Promise<Result<void>> => { const result = await machine.transition(input); return result.ok ? { ok: true, value: undefined } : result; };
  const act = new Act({ ...context, baseline: () => machine.view.current.n, evaluate: calculate,
    commit: async (digest, baseline) => {
      const release = trusted.releases.find(value => value.digest === digest); if (!release) return failure('not-found', 'The reviewed default release is not configured.');
      const before = machine.view.current;
      const switched = await context.runtime.group(context.administrator, release.targets, {
        begin: () => moved({ event: 'switch', reason: 'reviewer confirmed default', candidate: { ...before, pins: { release: digest } }, baseline, authorized: true }),
        frozen: async snapshots => {
          const drained = await moved({ event: 'drained', reason: 'all deployment writers frozen', active: 0 }); if (!drained.ok) return drained;
          const snapshot = await manifestSnapshot(context.root, { generation: before, targets: snapshots }); if (!snapshot.ok) return snapshot;
          return moved({ event: 'snapshot', reason: 'all frozen state hashes retained', snapshot: snapshot.value, snapshotVerified: true });
        },
        staged: async () => {
          const applied = await moved({ event: 'applied', reason: 'all deployment copies verified', pinsVerified: true, migrationsPassed: true, formatValid: true }); if (!applied.ok) return applied;
          return moved({ event: 'healthy', reason: 'all deployment private probes passed', probed: true, clientCompatible: true });
        },
        committed: async () => {
          const written = await atomicWrite(join(context.root, 'current.json'), Buffer.from(JSON.stringify({ digest, baseline: baseline + 1 }))); if (!written.ok) return written;
          return moved({ event: 'repointed', reason: 'all deployment endpoints switched and default pins renamed', atomic: true, stop: true });
        },
        failed: async (reason, restored) => {
          if (machine.view.state === 'QUIESCING') { const drained = await moved({ event: 'drained', reason: 'failed default transaction effects stopped', active: 0 }); if (!drained.ok) return drained; }
          const failed = await moved({ event: 'failed', reason }); if (!failed.ok) return failed;
          if (!restored) return moved({ event: 'failed', reason: 'one or more deployment targets could not restore' });
          const written = await atomicWrite(join(context.root, 'current.json'), Buffer.from(JSON.stringify({ digest: before.pins['release'], baseline: machine.view.committed ? Math.max(before.n, machine.view.candidate?.n ?? 0) + 1 : before.n }))); if (!written.ok) return written;
          return moved({ event: 'restored', reason, restored: true, probed: true });
        }
      });
      if (!switched.ok) return switched;
      const offered = await context.runtime.offer(digest, machine.view.current.n);
      if (!offered.ok) return context.journal.observed('default', 'default.offer-failed', { error: offered.error }, true);
      return { ok: true, value: undefined };
    }
  });
  for (const designation of trusted.plans) { const authorized = act.authorize(context.administrator, designation.source, designation.plan); if (!authorized.ok) return authorized; }
  const recorded = recovered ? await moved({ event: 'restart', reason: 'recovering the observed default', candidate: recovered.current, authorized: true }) : await context.journal.observed('default', 'generation.initial', { snapshot: machine.view }, true);
  return recorded.ok ? { ok: true, value: { act, machine, ready: () => recovered ? recoveryReady(context.root, machine, moved) : Promise.resolve({ ok: true, value: undefined }) } } : recorded;
}

async function recoveryReady(root: string, machine: Generations, move: (input: Input) => Promise<Result<void>>): Promise<Result<void>> {
  const restored = await move({ event: 'restored', reason: 'all recovered deployment members probed', restored: true, probed: true }); if (!restored.ok) return restored;
  const current = machine.view.current;
  return atomicWrite(join(root, 'current.json'), Buffer.from(JSON.stringify({ digest: current.pins['release'], baseline: current.n })));
}
