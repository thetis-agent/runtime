/** Project immutable generation history without selecting transitions or admitting work; ADR 0033. */
import type { Generation as StoredGeneration, View as StoredView } from './types.ts';
export type Generation = Pick<StoredGeneration, 'n' | 'pins' | 'stateSnapshot' | 'prefixRenderer' | 'at'>;
export type View = Pick<StoredView, 'state' | 'committed' | 'since'> & { current: Generation; candidate?: Generation; previous?: Generation };
export interface Projection { event: string; candidate?: Generation; snapshot?: string; stop?: boolean }
export function project(view: View, state: View['state'], input: Projection, now: number): View {
  const next: View = { ...structuredClone(view), state, since: now };
  if (input.event === 'switch' && input.candidate) next.candidate = { ...structuredClone(input.candidate), n: next.current.n + 1 };
  if (input.event === 'undo' && next.previous) next.candidate = { ...next.previous, n: next.current.n + 1 };
  if (input.event === 'restart' && input.candidate) next.current = { ...structuredClone(input.candidate), n: next.current.n };
  if (input.event === 'recovering' && input.candidate) next.candidate = structuredClone(input.candidate);
  if ((input.event === 'snapshot' || input.event === 'restart') && input.snapshot) next.current.stateSnapshot = input.snapshot;
  if (input.event === 'healthy' && input.snapshot && next.candidate) next.candidate.stateSnapshot = input.snapshot;
  if (input.event === 'healthy' || input.event === 'reset' || input.event === 'restart') next.committed = true;
  if ((input.event === 'closed' || input.event === 'repointed' && input.stop) && next.candidate) {
    next.previous = next.current; next.current = { ...next.candidate, at: now }; delete next.candidate; delete next.committed;
  }
  if (input.event === 'restored') {
    if (input.candidate) next.current = { ...structuredClone(input.candidate), at: now };
    else if (next.committed) next.current = { ...next.current, n: Math.max(next.current.n, next.candidate?.n ?? 0) + 1, at: now };
    if (input.snapshot) next.current.stateSnapshot = input.snapshot;
    delete next.candidate; delete next.committed;
  }
  return next;
}
