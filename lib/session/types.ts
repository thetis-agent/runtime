/** Generated from schema.json; defend wire compatibility (ADR 0006). Do not edit. */
import type * as TurnEvents from '@/contracts/turn-events/types.ts';
export type Event = TurnEvents.Envelope & ({ "type"?: "token"; "payload"?: TurnEvents.Token; [key: string]: unknown; } | { "type"?: "output"; "payload"?: TurnEvents.Output; [key: string]: unknown; } | { "type"?: "end"; "payload"?: TurnEvents.End; [key: string]: unknown; });
export type Batch = { "type": "session.events"; "conversation": string; "cursor": number; "events": (Event)[]; [key: string]: unknown; };
export type Subscribed = { "conversation": string; "cursor": number; "oldest": number; [key: string]: unknown; };
export type Contract = Batch;
