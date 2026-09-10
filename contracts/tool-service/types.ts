/** Generated from schema.json; defend wire compatibility (ADR 0006). Do not edit. */
import type * as TurnEvents from '@/contracts/turn-events/types.ts';
export type Request = { "v": "1"; "runToken": string; "call": TurnEvents.CallRequest; [key: string]: unknown; };
export type Response = TurnEvents.CallAnswer;
export type Contract = Request;
