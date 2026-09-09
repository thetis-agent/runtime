/** Generated from schema.json; defend wire compatibility (ADR 0006). Do not edit. */
export type BudgetRule = { "name": string; "cost": number; "requests": number; "windowMs": number; [key: string]: unknown; };
export type Startup = { "rule": BudgetRule; "settings": { [key: string]: unknown; }; "peopleLimit"?: number; [key: string]: unknown; };
export type Window = { "person": string; "at": number; "spent": number; "reserved": number; "requests": number; [key: string]: unknown; };
export type Checkpoint = { "version": 1; "windows": (Window)[]; [key: string]: unknown; };
export type Contract = Checkpoint;
