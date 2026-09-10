/** Preserve shared imports while the evaluator contract owns every wire type; ADR 0006. */
export type { Name, Identities, Strings, Row, Submission, Plan, Task, Interval, Summary, Gate, Release, Outcome, ScoreOutcome, Startup, Request, Mutation, Withheld, TurnJob, CheckJob, RunRequest, ScoreRequest, ReleaseRequest, Contract } from '@/contracts/evaluator/types.ts';
