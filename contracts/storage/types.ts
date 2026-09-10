/** Generated from schema.json; defend wire compatibility (ADR 0006). Do not edit. */
export type Key = string;
export type Limits = { "entries": number; "valueBytes": number; "bytes": number; [key: string]: unknown; };
export type AppendLimits = { "rowBytes": number; "queuedRows": number; [key: string]: unknown; };
export type Error = { "code": "invalid-args" | "budget" | "io" | "not-found"; "message": string; [key: string]: unknown; };
export type Contract = Limits;
