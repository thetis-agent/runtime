/** Apply an ordinary run's trusted cost ceiling before vendor access; ADR 0020, PR-010. */
import { createHash } from 'node:crypto';
import type { Budgets, Caller } from './index.ts';
import type { Result } from '../schema/index.ts';
import { failure } from '../schema/index.ts';

export function reserve(budgets: Budgets, caller: Caller, token: string, estimate: number, scope: 'person' | 'deployment'): Result<(actual: number) => void, 'budget'> {
  const reservations: ((actual: number) => void)[] = [];
  if (caller.cost !== undefined) {
    if (caller.expires === undefined) return failure('budget', 'The trusted run retirement deadline is required.');
    const run = budgets.reserveRun(createHash('sha256').update(token).digest('hex'), estimate, caller.cost, caller.expires);
    if (!run.ok) return run; reservations.push(run.value);
  }
  if (scope === 'deployment') {
    const person = budgets.reserve(caller.person, estimate);
    if (!person.ok) { for (const settle of reservations) settle(0); return person; }
    reservations.push(person.value);
  }
  return { ok: true, value(actual) { for (const settle of reservations) settle(actual); } };
}
