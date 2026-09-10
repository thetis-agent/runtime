/** Describe trusted execution edges without teaching the kernel model or scorer semantics; ADR 0017. */
import type { Setup } from '../package-loader/types.ts';
import type { Plan as SandboxPlan, SandboxRunner } from '../sandbox-runner/index.ts';
import type { Clock } from '../events/index.ts';
import type { Result } from '../result/index.ts';
import type { Method } from '../../contracts/kernel-socket/types.ts';
import type { Startup, Row } from './types.ts';
import type { Socket } from 'node:net';

export interface Candidate {
  probe(): Promise<Result<void>>;
  invoke(method: Method, params: Record<string, unknown>): Promise<Result<unknown>>;
  freeze(): Promise<Result<void>>;
  stop(reason: string): Promise<Result<void>>;
  facts(): Promise<Result<{ counters: Record<string, number>; iterations: number; dropped: number; end: Row['end'] }>>;
}
export interface ExecutionHost {
  root: string; runner: SandboxRunner; clock: Clock;
  launch(plan: Omit<SandboxPlan, 'socket' | 'token'>, setup: Setup, policy: { cost: number }): Promise<Result<Candidate>>;
  authority(): Promise<Result<{ socket: Socket; token: string; close(): Promise<Result<void>> }>>;
  observe(kind: string, value: Record<string, unknown>): Promise<Result<void>>;
}
export interface Arm { plan: Omit<SandboxPlan, 'socket' | 'token'>; setup: Setup; pins: Readonly<Record<string, { source: string; hash: string }>> }
export interface TaskFixture { source: string; hash: string; checks: Readonly<Record<string, { path: string; hash: string }>> }
export interface ExecutionConfiguration {
  source: string; startup: Startup; arms: Readonly<Record<string, Arm>>;
  fixtures: Readonly<Record<string, TaskFixture>>; privateRoots: readonly string[];
}
export interface Frozen { path: string; task: string; hash: string; mutation: Record<string, string> }
export const executionLimits = { active: 1, snapshots: 256, checks: 256, quotaBytes: 67108864 };
