/** Supply scripted vendor events and a real run identity to provider tests; PR-014. */
import { Identity } from '../kernel/identity/index.ts';
import { MockProvider } from '../packages/provider-mock/index.ts';
import { Budgets } from '../lib/provider/index.ts';
import { failure } from '../lib/schema/index.ts';
import type { RequestEvent, ResponseEvent } from '../contracts/provider/types.ts';

export function providerFixture(scripts: readonly (readonly ResponseEvent[])[] = [], cost = 10) {
  const identity = new Identity({ people: [{ id: 'person', role: 'user', projects: [], observeOthers: false }], bindings: [], authorities: {} }, () => 0);
  const issued = identity.issue({ id: 'run', person: 'person', scope: 'person', target: 'person', generation: 1, services: ['instance'] });
  if (!issued.ok) throw new Error('Provider fixture failed to issue its run.');
  const reports: { token: string; callId: string; counters: Record<string, number> }[] = [];
  const authority = {
    whois: (token: string) => {
      const run = identity.authenticate(token);
      return Promise.resolve(run.ok ? run : failure('auth', 'The caller is unknown.'));
    },
    report: (token: string, callId: string, counters: Record<string, number>) => {
      if (!identity.authenticate(token).ok) return Promise.resolve(failure('auth', 'The caller is unknown.'));
      reports.push({ token, callId, counters: structuredClone(counters) });
      return Promise.resolve({ ok: true, value: undefined } satisfies { ok: true; value: undefined });
    }
  };
  const budgets = new Budgets({ name: 'daily-cost', cost, requests: 100, windowMs: 86400000 }, () => 0);
  return { provider: new MockProvider(scripts, authority, budgets), token: issued.value, reports, identity };
}

export function request(prefix = 'system', extra: Record<string, unknown> = {}): RequestEvent[] {
  return [
    { type: 'begin', id: 'call', model: 'scripted', cache: { prefixThrough: 0 }, ...extra },
    { type: 'message', role: 'system', content: [{ type: 'text', text: prefix }] },
    { type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    { type: 'end' }
  ];
}

export async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) {
    if (result.length >= 8192) throw new Error('Test stream exceeds its item limit.');
    result.push(item);
  }
  return result;
}

export function stream<T>(values: readonly T[]): AsyncIterable<T> {
  return { async *[Symbol.asyncIterator]() {
    for (const value of values) { await Promise.resolve(); yield value; }
  } };
}
