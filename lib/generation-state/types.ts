/** Generated from schema.json; defend wire compatibility (ADR 0006). Do not edit. */
import type * as Deployment from '@/lib/deployment/types.ts';
export type Generation = { "n": number; "pins": { [key: string]: string; }; "stateSnapshot": string; "prefixRenderer": string; "at": number; [key: string]: unknown; };
export type View = { "state": "LIVE" | "QUIESCING" | "FROZEN" | "APPLYING" | "PROBING" | "SWITCHING" | "DRAINING" | "ROLLING_BACK" | "FAILED"; "current": Generation; "candidate"?: Generation; "previous"?: Generation; "committed"?: boolean; "since": number; [key: string]: unknown; };
export type Row = { "provenance": "kernel-observed" | "candidate-reported" | "reviewed-reported"; "at": number; "target": string; "kind": string; "data": { [key: string]: unknown; }; [key: string]: unknown; };
export type Checkpoint = { "version": 1; "target": Deployment.Target; "pins": { [key: string]: { "source": string; "hash": string; "mount": string; [key: string]: unknown; }; }; "view": View; "state": string; "endpoint": string; [key: string]: unknown; };
export type Contract = View;
