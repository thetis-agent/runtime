/** Generated from schema.json; defend wire compatibility (ADR 0006). Do not edit. */
export type BudgetRule = { "name": string; "cost": number; "requests": number; "windowMs": number; [key: string]: unknown; };
export type Startup = { "rule": BudgetRule; "settings": { [key: string]: unknown; }; "peopleLimit"?: number; [key: string]: unknown; };
export type Window = { "person": string; "at": number; "spent": number; "reserved": number; "requests": number; [key: string]: unknown; };
export type Decimal = string;
export type PersonBalance = { "person": string; "at": number; "spent": Decimal; "reserved": Decimal; "requests": number; [key: string]: unknown; };
export type RunBalance = { "digest": string; "expires"?: number; "at": number; "spent": Decimal; "reserved": Decimal; "requests": number; [key: string]: unknown; };
export type Ledger = { "version": 2; "people": (PersonBalance)[]; "runs": (RunBalance)[]; [key: string]: unknown; };
export type Legacy = { "version": 1; "windows": (Window)[]; [key: string]: unknown; };
export type Checkpoint = Legacy | Ledger;
export type Contract = Checkpoint;
