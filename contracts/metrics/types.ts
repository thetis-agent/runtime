/** Generated from schema.json; defend wire compatibility (ADR 0006). Do not edit. */
import type * as Evaluator from '@/contracts/evaluator/types.ts';
export type Request = { "method": "summary"; "submission": Evaluator.Submission; "plan": Evaluator.Plan; "v": "1"; [key: string]: unknown; } | { "method": "logs"; "target": string; "from"?: number; "limit"?: number; "v": "1"; [key: string]: unknown; };
export type GoldPair = { "query": string; "skills": (string)[]; [key: string]: unknown; };
export type Contract = Request;
