/** Share validated evaluation identities and arithmetic without granting promotion authority; ADR 0014. */
import schema from '@/contracts/evaluator/schema.json' with { type: 'json' };
import type { Schemas, Validator } from '@/lib/schema/index.ts';
import type { Plan, Submission, Task } from './types.ts';
export type { Plan, Submission, Task, Row, Identities } from './types.ts';
export { gate, summarize, bootstrap, metricLimits } from './metrics.ts';
export type { Gate, Summary, Interval } from './metrics.ts';
export { seed, seedIdentity } from './random.ts';

export function validators(schemas: Schemas): { submission: Validator<Submission>; plan: Validator<Plan>; task: Validator<Task> } {
  schemas.compile(schema);
  return {
    submission: schemas.compile<Submission>({ $ref: `${schema.$id}#/$defs/submission` }),
    plan: schemas.compile<Plan>({ $ref: `${schema.$id}#/$defs/plan` }),
    task: schemas.compile<Task>({ $ref: `${schema.$id}#/$defs/task` })
  };
}

export { calculate, calculationLimits } from './async.ts';
