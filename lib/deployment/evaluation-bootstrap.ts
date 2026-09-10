/** Bind private execution inputs to the approved evidence plan before admitting its designated reporter; EV-002, EV-006. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ExecutionRuntime, executionCapabilities } from '../evaluation/runtime.ts';
import type { ExecutionConfiguration, Arm } from '../evaluation/runtime.ts';
import { evaluationHost } from './evaluation.ts';
import type { EvaluationBridge } from './evaluation.ts';
import { validator } from '../package-loader/index.ts';
import type { Setup } from '../package-loader/types.ts';
import { failure } from '../schema/index.ts';
import type { Schemas, Result } from '../schema/index.ts';
import type { Execution, Trusted } from './types.ts';
import type { Method } from '../../contracts/kernel-socket/types.ts';
interface Context extends Omit<EvaluationBridge, 'start'> {
  start(account: string, services: readonly string[], ...args: Parameters<EvaluationBridge['start']>): ReturnType<EvaluationBridge['start']>;
  endpoint(id: string): Result<string>;
}
type Operation = (run: { target: string; scope: string }, params: Record<string, unknown>) => Promise<Result<unknown>>;
export interface Evaluation { extension(source: string): { capabilities: readonly string[]; methods: ReadonlyMap<Method, Operation> }; close(): Promise<Result<void>> }
export async function evaluationBootstrap(context: Context, trusted: Pick<Trusted, 'execution' | 'plans'>): Promise<Result<Evaluation>> {
  const configurations = new Map<string, ExecutionConfiguration>();
  const runtimes = new Map<string, ExecutionRuntime>();
  for (const input of trusted.execution ?? []) {
    const approved = trusted.plans.find(plan => plan.source === input.source);
    if (!approved || JSON.stringify(approved.plan) !== JSON.stringify(input.startup.plan) || configurations.has(input.source)) return failure('forbidden', 'The private execution plan does not match its designated evidence authority.');
    const config = await configuration(input, context.schemas); if (!config.ok) return config;
    configurations.set(input.source, config.value);
  }
  return { ok: true, value: {
    extension(source: string) {
      const input = trusted.execution?.find(input => input.source === source); const config = configurations.get(source);
      if (!input || !config) return { capabilities: [], methods: new Map<Method, Operation>() };
      const operations = new Map<Method, (run: { target: string; scope: string }, params: Record<string, unknown>) => Promise<Result<unknown>>>();
      for (const method of ['install', 'snapshot', 'prune'] satisfies Method[]) operations.set(method, async (run, params) => {
        if (run.target !== source || run.scope !== 'deployment') return failure('forbidden', 'This run is not authorized for private evaluation.');
        let runtime = runtimes.get(source);
        if (!runtime) {
          const resolved = resolve(config, context); if (!resolved.ok) return resolved;
          runtime = new ExecutionRuntime(evaluationHost({ ...context, root: join(context.root, createHash('sha256').update(source).digest('base64url')), start: (...args) => context.start(input.account, input.services, ...args) }), resolved.value); runtimes.set(source, runtime);
        }
        const handler = runtime.operations(context.schemas).get(method); if (!handler) throw new Error('An execution operation was not installed.');
        return handler(run, params);
      });
      return { capabilities: executionCapabilities, methods: operations };
    },
    async close(): Promise<Result<void>> { for (const runtime of runtimes.values()) { const closed = await runtime.close(); if (!closed.ok) return closed; } return { ok: true, value: undefined }; }
  } };
}
async function configuration(input: Execution, schemas: Schemas): Promise<Result<ExecutionConfiguration>> {
  const check = await validator<Setup>(schemas, 'setup'); const arms: Record<string, Arm> = {};
  for (const [id, arm] of Object.entries(input.arms)) {
    if (!check(arm.setup)) return failure('invalid-args', 'An approved execution arm has an invalid setup.');
    if (arm.setup.runtime?.person !== input.account) return failure('forbidden', 'The execution arm does not use its ordinary account identity.');
    arms[id] = { ...arm, setup: arm.setup };
  }
  return { ok: true, value: { ...input, arms } };
}
function resolve(config: ExecutionConfiguration, context: Context): Result<ExecutionConfiguration> {
  const copy = structuredClone(config);
  for (const arm of Object.values(copy.arms)) for (const mount of arm.plan.mounts) {
    if (!mount.source.startsWith('service:')) continue;
    const endpoint = context.endpoint(mount.source.slice(8)); if (!endpoint.ok) return endpoint;
    mount.source = endpoint.value;
  }
  return { ok: true, value: copy };
}
