/** Give paid-tool tests ordinary kernel identities without changing the accounting path; TS-005. */
import assert from 'node:assert/strict';
import { Identity } from '@/kernel/identity/index.ts';
import { Budgets } from '@/lib/provider/index.ts';
import { failure } from '@/lib/schema/index.ts';
export function toolIdentity(cost = 10) {
  const identity = new Identity({ people: ['person', 'bob'].map(id => ({ id, role: 'user', projects: [], observeOthers: false })), bindings: [], authorities: {} }, () => 0);
  const issued = identity.issue({ id: 'run', person: 'person', scope: 'person', target: 'run', generation: 1, services: ['tools'] }); assert.ok(issued.ok);
  const reports: { token: string; callId: string; counters: Record<string, number> }[] = [];
  const authority = {
    whois: (token: string) => { const run = identity.authenticate(token); return Promise.resolve(run.ok ? run : failure('auth', 'The caller is unknown.')); },
    report: (token: string, callId: string, counters: Record<string, number>) => {
      if (!identity.authenticate(token).ok) return Promise.resolve(failure('auth', 'The caller is unknown.'));
      reports.push({ token, callId, counters }); return Promise.resolve({ ok: true, value: undefined } as const);
    }
  };
  return { identity, token: issued.value, reports, authority, budgets: new Budgets({ name: 'tool-cost', cost, requests: 100, windowMs: 86400000 }, () => 0) };
}
