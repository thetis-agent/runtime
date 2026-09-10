/** Bind private execution inputs to the approved evidence plan before admitting its designated reporter; EV-002, EV-006. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ExecutionRuntime, executionCapabilities } from '@/lib/evaluation/runtime.ts';
import type { ExecutionConfiguration, Arm } from '@/lib/evaluation/runtime.ts';
import { evaluationHost } from './evaluation.ts';
import type { EvaluationBridge } from './evaluation.ts';
import { validator } from '@/lib/package-loader/index.ts';
import type { Setup } from '@/lib/package-loader/types.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Schemas, Result } from '@/lib/schema/index.ts';
import type { Execution, Trusted } from './types.ts';
import type { Method } from '@/contracts/kernel-socket/types.ts';
interface Context extends Omit<EvaluationBridge, 'start'> {
  start(account: string, services: readonly string[], ...args: Parameters<EvaluationBridge['start']>): ReturnType<EvaluationBridge['start']>;
  endpoint(id: string): Result<string>;
}
type Operation = (run: { target: string; scope: string }, params: Record<string, unknown>) => Promise<Result<unknown>>;
type Invoke = (method: Method, ...args: Parameters<Operation>) => ReturnType<Operation>;
export interface Evaluation { extension(source: string): { capabilities: readonly string[]; methods: ReadonlyMap<Method, Operation> }; close(): Promise<Result<void>> }
export async function evaluationBootstrap(context: Context, trusted: Pick<Trusted, 'execution' | 'plans'>): Promise<Result<Evaluation>> {
  const sources = new Map<string, Invoke>();
  const runtimes = new Map<string, ExecutionRuntime>();
  for (const input of trusted.execution ?? []) {
    const approved = trusted.plans.find(plan => plan.source === input.source);
    if (!approved || JSON.stringify(approved.plan) !== JSON.stringify(input.startup.plan) || sources.has(input.source)) return failure('forbidden', 'The private execution plan does not match its designated evidence authority.');
    const config = await configuration(input, context.schemas); if (!config.ok) return config;
    const create = (): Result<ExecutionRuntime> => {
      const runtime = execution(context, input, config.value);
      if (runtime.ok) runtimes.set(input.source, runtime.value);
      return runtime;
    };
    sources.set(input.source, lazyInvoker(input.source, context.schemas, create));
  }
  return { ok: true, value: {
    extension(source: string) {
      const invoke = sources.get(source);
      if (!invoke) return { capabilities: [], methods: new Map<Method, Operation>() };
      const operations = new Map<Method, Operation>();
      for (const method of ['install', 'snapshot', 'prune'] satisfies Method[]) {
        operations.set(method, (run, params) => invoke(method, run, params));
      }
      return { capabilities: executionCapabilities, methods: operations };
    },
    async close(): Promise<Result<void>> {
      for (const runtime of runtimes.values()) {
        const closed = await runtime.close(); if (!closed.ok) return closed;
      }
      return { ok: true, value: undefined };
    }
  } };
}

function lazyInvoker(source: string, schemas: Schemas, create: () => Result<ExecutionRuntime>): Invoke {
  let runtime: ExecutionRuntime | undefined;
  let operations: ReturnType<ExecutionRuntime['operations']> | undefined;
  return async (method, run, params) => {
    if (run.target !== source || run.scope !== 'deployment') return failure('forbidden', 'This run is not authorized for private evaluation.');
    if (!runtime) {
      const created = create(); if (!created.ok) return created;
      runtime = created.value;
    }
    operations ??= runtime.operations(schemas);
    const handler = operations.get(method);
    if (!handler) throw new Error('An execution operation was not installed.');
    return handler(run, params);
  };
}

function execution(context: Context, input: Execution, config: ExecutionConfiguration): Result<ExecutionRuntime> {
  const resolved = resolve(config, context); if (!resolved.ok) return resolved;
  const root = join(context.root, createHash('sha256').update(input.source).digest('base64url'));
  const host = evaluationHost({
    ...context,
    root,
    start: (...args) => context.start(input.account, input.services, ...args)
  });
  return { ok: true, value: new ExecutionRuntime(host, resolved.value) };
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
