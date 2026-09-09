/** Attribute service calls through the inherited kernel peer, never through prompt content; PR-011–012. */
import type { Peer } from '../socket/index.ts';
import { failure, isObject } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';
import type { Authority, Caller } from './index.ts';

export class KernelAuthority implements Authority {
  readonly #peer: Peer;
  constructor(peer: Peer) { this.#peer = peer; }

  async whois(token: string): Promise<Result<Caller, 'auth'>> {
    const result = await this.#peer.call('token.whois', { runToken: token });
    if (!result.ok || !isObject(result.value)) return failure('auth', 'The kernel could not authenticate the caller.');
    const person = result.value['person']; const scope = result.value['scope'];
    if (typeof person !== 'string' || (scope !== 'person' && scope !== 'deployment')) return failure('auth', 'The kernel returned an invalid caller identity.');
    return { ok: true, value: { person, scope } };
  }

  async report(token: string, callId: string, counters: Record<string, number>): Promise<Result<void, 'auth'>> {
    const result = await this.#peer.call('usage.report', { runToken: token, callId, counters });
    return result.ok ? { ok: true, value: undefined } : failure('auth', 'The kernel did not accept the usage attribution.');
  }
}
