/** Keep scoped session negotiation identical at both ends of the boundary; KS-004. */
import type { Method } from '@/contracts/kernel-socket/types.ts';
export const sessionMethods: readonly Method[] = ['session.list', 'session.create', 'session.submit', 'session.subscribe', 'session.cancel'];
