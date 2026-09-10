/** Generated from schema.json; defend wire compatibility (ADR 0006). Do not edit. */
export type Artifact = { "version": 1; "generator": "node:stripTypeScriptTypes:strip"; "runtime": string; "source": string; "output": string; [key: string]: unknown; };
export type Job = { "source": string; "destination": string; "previous"?: string; [key: string]: unknown; };
export type Reply = { "ok": true; [key: string]: unknown; } | { "ok": false; "error": Error; [key: string]: unknown; };
export type Error = { "code": "invalid-args" | "hash-mismatch" | "outside-roots" | "budget" | "io" | "deadline"; "message": string; [key: string]: unknown; };
export type Contract = Artifact;
