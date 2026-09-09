/** Negotiate only control and completion metadata across the monitor channel; ADR 0019, ADR 0027. */
import type { Method } from '../../contracts/kernel-socket/types.ts';
export const sessionMethods: readonly Method[] = ['session.list', 'session.create', 'session.submit', 'session.cancel'];
export const capabilities = ['health.probe', ...sessionMethods, 'run.stop', 'env.updated', 'turn.report'];
