/** Generated from schema.json; defend wire compatibility (ADR 0006). Do not edit. */
export type Command = { "id": string; "method": "activate" | "pause" | "resume" | "stop" | "status" | "whois"; "session"?: string; [key: string]: unknown; };
export type Principal = { "person": string; "role": "admin" | "reviewer" | "user"; [key: string]: unknown; };
export type Control = { "id": string; "method": "status" | "update" | "undo" | "stop"; "session"?: string; "release"?: string; "baseline"?: number; [key: string]: unknown; };
export type Pins = { "entry": string; "pins": { [key: string]: string; }; [key: string]: unknown; };
export type Reply = { "id": string; "ok": true; "value"?: unknown; [key: string]: unknown; } | { "id": string; "ok": false; "error": { "code": "invalid-args" | "unsupported" | "deadline" | "io" | "forbidden" | "budget"; "message": string; [key: string]: unknown; }; [key: string]: unknown; };
export type Ready = { "ready": true; "endpoint": string; [key: string]: unknown; };
export type Hello = { "v": string; "capabilities": (string)[]; [key: string]: unknown; };
export type Welcome = { "v": string; "capabilities": (string)[]; "person": string; "scope": "person" | "deployment"; [key: string]: unknown; };
export type Status = { "clients": (string)[]; [key: string]: unknown; };
export type Contract = Command;
