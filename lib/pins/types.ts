/** Generated from schema.json; defend wire compatibility (ADR 0006). Do not edit. */
export type Lease = { "target": string; "conversation": string; "hashes": (string)[]; [key: string]: unknown; };
export type State = (Lease)[];
export type Contract = State;
