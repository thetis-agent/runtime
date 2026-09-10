/** Generated from schema.json; defend wire compatibility (ADR 0006). Do not edit. */
import type * as TurnEvents from '@/contracts/turn-events/types.ts';
import type * as Skills from '@/contracts/skills/types.ts';
export type Event = TurnEvents.Envelope & ({ "type"?: "token"; "payload"?: TurnEvents.Token; [key: string]: unknown; } | { "type"?: "output"; "payload"?: TurnEvents.Output; [key: string]: unknown; } | { "type"?: "end"; "payload"?: TurnEvents.End; [key: string]: unknown; } | { "type"?: "input"; "payload"?: TurnEvents.Input; [key: string]: unknown; } | { "type"?: "call"; "payload"?: TurnEvents.CallRequest | TurnEvents.CallAnswer; [key: string]: unknown; } | { "type"?: "notice"; "payload"?: TurnEvents.Notice; [key: string]: unknown; } | { "type"?: "model.event"; "payload"?: TurnEvents.ModelEvent; [key: string]: unknown; } | { "type"?: "retrieve"; "payload"?: Skills.RetrieveAnswer; [key: string]: unknown; });
export type Batch = { "type": "session.events"; "conversation": string; "cursor": number; "events": (Event)[]; [key: string]: unknown; };
export type History = { "messages": (TurnEvents.Message)[]; "truncated": boolean; [key: string]: unknown; };
export type Subscribed = { "conversation": string; "cursor": number; "history"?: History; "oldest": number; [key: string]: unknown; };
export type Contract = Batch;
