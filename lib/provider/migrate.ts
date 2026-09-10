/** Preserve numeric checkpoints and legacy run spend without guessing a retirement date; ADR 0044. */
import type { Checkpoint, Ledger } from './types.ts';
import { decimal, money } from './money.ts';

export function migrate(checkpoint: Checkpoint): Ledger {
  if (checkpoint.version === 2) return checkpoint;
  const ledger: Ledger = { version: 2, people: [], runs: [] };
  for (const window of checkpoint.windows) {
    const amounts = { at: window.at, requests: window.requests, spent: decimal(money(window.spent)), reserved: decimal(money(window.reserved)) };
    if (window.person.startsWith('\0run:')) ledger.runs.push({ digest: window.person.slice(5), ...amounts });
    else ledger.people.push({ person: window.person, ...amounts });
  }
  return ledger;
}
