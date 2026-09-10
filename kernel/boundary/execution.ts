/** Bind transient generations to an ordinary principal and a kernel-held cost ceiling; EV-006, ADR 0017. */
import { join } from 'node:path';
import { Driver } from '@/kernel/generations/driver.ts';
import type { Context } from '@/kernel/boundary/process.ts';
import type { Revision } from '@/kernel/generations/prepare.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
export async function execution(context: Context, root: string, owner: string, services: readonly string[], cost: number, revision: Revision, state: string): Promise<Result<Driver>> {
  if (!context.identity.principal(owner)) return failure('unbound', 'The execution account has no ordinary principal.');
  if (!Number.isFinite(cost) || cost < 0) return failure('invalid-args', 'The execution cost ceiling is invalid.');
  return Driver.start({ root: join(root, context.target), owner, scope: 'person', services, cost, context }, revision, state,
    { n: 1, stateSnapshot: '', pins: Object.fromEntries(Object.entries(revision.pins).map(([name, pin]) => [name, pin.hash])), prefixRenderer: '1', at: context.clock.now() });
}
