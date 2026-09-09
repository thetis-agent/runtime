/** Keep generation transitions reviewable as data; ADR 0012, design/generations transitions. */
export type State = 'LIVE' | 'QUIESCING' | 'FROZEN' | 'APPLYING' | 'PROBING' | 'SWITCHING' | 'DRAINING' | 'ROLLING_BACK' | 'FAILED';
export type Event = 'switch' | 'undo' | 'drained' | 'snapshot' | 'applied' | 'healthy' | 'repointed' | 'closed' | 'restored' | 'failed';
export type Guard = 'authorized' | 'undoable' | 'drained' | 'snapshot' | 'applied' | 'healthy' | 'atomic' | 'closed' | 'restored' | 'always';
export interface Transition { from: State; event: Event; guard: Guard; to: State; stop?: boolean; effects: readonly string[] }
export const transitions: readonly Transition[] = [
  { from: 'LIVE', event: 'switch', guard: 'authorized', to: 'QUIESCING', effects: ['refuse-admissions', 'run.stop'] },
  { from: 'LIVE', event: 'undo', guard: 'undoable', to: 'QUIESCING', effects: ['refuse-admissions', 'run.stop', 'list-writes'] },
  { from: 'QUIESCING', event: 'drained', guard: 'drained', to: 'FROZEN', effects: ['stop-writers', 'kill-overdue-turns'] },
  { from: 'FROZEN', event: 'snapshot', guard: 'snapshot', to: 'APPLYING', effects: ['record-snapshot'] },
  { from: 'APPLYING', event: 'applied', guard: 'applied', to: 'PROBING', effects: ['start-private'] },
  { from: 'PROBING', event: 'healthy', guard: 'healthy', to: 'SWITCHING', effects: ['adopt-copy', 'fence'] },
  { from: 'SWITCHING', event: 'repointed', guard: 'atomic', to: 'DRAINING', stop: false, effects: ['route-new-connections'] },
  { from: 'SWITCHING', event: 'repointed', guard: 'atomic', to: 'LIVE', stop: true, effects: ['stop-old', 'route-new-connections', 'env.updated'] },
  { from: 'DRAINING', event: 'closed', guard: 'closed', to: 'LIVE', effects: ['stop-old', 'env.updated'] },
  { from: 'ROLLING_BACK', event: 'restored', guard: 'restored', to: 'LIVE', effects: ['list-writes', 'resume-admissions'] },
  ...(['FROZEN', 'APPLYING', 'PROBING', 'SWITCHING', 'DRAINING'] satisfies State[]).map((from): Transition => ({ from, event: 'failed', guard: 'always', to: 'ROLLING_BACK', effects: ['record-reason', 'stop-candidate', 'restore-snapshot'] })),
  { from: 'ROLLING_BACK', event: 'failed', guard: 'always', to: 'FAILED', effects: ['stop-target', 'offer-reset'] }
];
