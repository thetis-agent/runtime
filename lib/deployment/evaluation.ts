/** Adapt kernel-owned processes to private evaluation without delegating identity authority; EV-002, EV-006. */
import type { Clock } from '../events/index.ts';
import type { Schemas } from '../schema/index.ts';
import type { Result } from '../result/index.ts';
import type { Setup } from '../package-loader/types.ts';
import type { Plan, SandboxRunner } from '../sandbox-runner/index.ts';
import type { Method } from '../../contracts/kernel-socket/types.ts';
import type { ExecutionHost } from '../evaluation/runtime.ts';
import { facts } from '../evaluation/facts.ts';

export interface EvaluationProcess {
  probe(): Promise<Result<void>>;
  invoke(method: Method, params: Record<string, unknown>): Promise<Result<unknown>>;
  stop(reason: string): Promise<Result<void>>;
  running: { freeze(frozen: boolean, clock: Clock): Promise<Result<void>> };
}
export interface EvaluationBridge {
  root: string;
  journal: string;
  runner: SandboxRunner;
  clock: Clock;
  schemas: Schemas;
  start(plan: Omit<Plan, 'socket' | 'token'>, setup: Setup, policy: { cost: number }): Promise<Result<{
    process: EvaluationProcess;
    target: string;
    diagnostic(): unknown;
  }>>;
  authority: ExecutionHost['authority'];
  observe: ExecutionHost['observe'];
}

export function evaluationHost(bridge: EvaluationBridge): ExecutionHost {
  return {
    root: bridge.root, runner: bridge.runner, clock: bridge.clock,
    authority: bridge.authority, observe: bridge.observe,
    async launch(plan, setup, policy) {
      const started = await bridge.start(plan, setup, policy); if (!started.ok) return started;
      const { process, target } = started.value;
      return { ok: true, value: {
        probe: () => process.probe(), invoke: (method, params) => process.invoke(method, params),
        freeze: () => process.running.freeze(true, bridge.clock), stop: reason => process.stop(reason),
        facts: () => facts(bridge.journal, target, started.value.diagnostic(), bridge.schemas)
      } };
    }
  };
}
