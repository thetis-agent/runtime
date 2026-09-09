/** Launch and probe only credentialled sandbox processes, observing their actual exit; GN-003, KS-017. */
import type { Method } from '../../contracts/kernel-socket/types.ts';
import type { Schemas, Result } from '../../lib/schema/index.ts';
import { failure, isObject } from '../../lib/schema/index.ts';
import type { Clock } from '../../lib/events/index.ts';
import type { SandboxRunner, Plan, Running } from '../../lib/sandbox-runner/index.ts';
import { socketPair } from '../../lib/socket/pair.ts';
import type { Pair } from '../../lib/socket/pair.ts';
import type { Peer } from '../../lib/socket/index.ts';
import { accept } from '../socket/index.ts';
import type { Operations } from '../socket/index.ts';
import type { Identity } from '../identity/index.ts';
import type { Journal } from '../log/index.ts';

export const limits = { turnMs: 600000, pending: 128, probeMs: 10000 };
export interface Context { target: string; identity: Identity; schemas: Schemas; clock: Clock; runner: SandboxRunner; journal: Journal; operations: Operations }

export class Process {
  readonly running: Running;
  readonly control: Peer;
  readonly #pair: Pair;
  readonly #context: Context;
  readonly #token: string;
  readonly #active = new Set<Promise<Result<unknown>>>();
  #stopping: Promise<Result<void>> | undefined;
  private constructor(running: Running, control: Peer, pair: Pair, token: string, context: Context) {
    this.running = running; this.control = control; this.#pair = pair; this.#token = token; this.#context = context;
  }

  static async start(plan: Omit<Plan, 'socket' | 'token'>, token: string, context: Context): Promise<Result<Process>> {
    const authenticated = context.identity.authenticate(token, 'probe'); if (!authenticated.ok) return authenticated;
    const pair = await socketPair(); if (!pair.ok) return pair;
    const accepting = accept(pair.value.peer, token, context.identity, context.schemas, context.clock, context.operations);
    const started = await context.runner.start({ ...plan, socket: pair.value.client, token });
    if (!started.ok) { const closed = await pair.value.close(); await accepting; context.identity.revoke(token); return closed.ok ? started : closed; }
    const connected = await accepting;
    if (!connected.ok) {
      const stopped = await started.value.stop(); const closed = await pair.value.close(); context.identity.revoke(token);
      return !stopped.ok ? stopped : !closed.ok ? closed : connected;
    }
    const process = new Process(started.value, connected.value, pair.value, token, context);
    const observed = await context.journal.observed(context.target, 'process.start', { pid: started.value.process.pid });
    if (!observed.ok) { const stopped = await process.stop('start observation failed'); return stopped.ok ? observed : stopped; }
    return { ok: true, value: process };
  }

  async probe(): Promise<Result<void>> {
    const answer = await this.control.call('health.probe', {}, limits.probeMs);
    if (!answer.ok) return answer;
    return isObject(answer.value) && answer.value['ready'] === true ? { ok: true, value: undefined } : failure('io', 'The generation did not answer healthy.');
  }

  async invoke(method: Method, params: Record<string, unknown>): Promise<Result<unknown>> {
    if (this.#stopping) return failure('switching', 'The generation is stopping.');
    if (this.#active.size >= limits.pending) return failure('budget', 'The generation request pool is full.');
    const result = this.control.call(method, params, limits.turnMs);
    this.#active.add(result); try { return await result; } finally { this.#active.delete(result); }
  }

  async drain(deadlineMs: number): Promise<Result<{ killed: boolean }>> {
    const signalled = await this.control.notify({ note: 'run.stop', params: { deadlineMs } });
    if (!signalled.ok) { const stopped = await this.stop('run.stop delivery failed'); return stopped.ok ? { ok: true, value: { killed: true } } : stopped; }
    const timer = new AbortController();
    const deadline = this.#context.clock.wait(deadlineMs, timer.signal).then(() => 'deadline');
    try {
      const done = await Promise.race([Promise.all(this.#active).then(() => 'drained'), deadline]);
      if (done === 'drained') return { ok: true, value: { killed: false } };
      const stopped = await this.stop('killed-for-switch');
      return stopped.ok ? { ok: true, value: { killed: true } } : stopped;
    } finally { timer.abort(); await deadline; }
  }

  stop(reason: string): Promise<Result<void>> { this.#stopping ??= this.#stop(reason); return this.#stopping; }

  async #stop(reason: string): Promise<Result<void>> {
    const stopped = await this.running.stop();
    this.control.close(); const endpoints = await this.#pair.close(); await this.control.finished(); this.#context.identity.revoke(this.#token);
    if (!stopped.ok) return stopped; if (!endpoints.ok) return endpoints;
    const exit = await this.running.exited;
    return this.#context.journal.observed(this.#context.target, 'process.exit', { reason, ...exit }, true);
  }
}
