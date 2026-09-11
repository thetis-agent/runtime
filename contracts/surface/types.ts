/** Generated from schema.json; defend wire compatibility (ADR 0006). Do not edit. */
export type Name = string;
export type Asset = string;
export type Panel = { "id": Name; "label": string; "hint"?: string; "wide"?: boolean; "entry": Asset; [key: string]: unknown; };
export type Verb = string;
export type Command = { "verb": Verb; "label": string; "role"?: "user" | "reviewer" | "admin"; [key: string]: unknown; };
export type Renderer = { "kind": string; "entry": Asset; [key: string]: unknown; };
export type Surface = { "v": "1"; "panels"?: (Panel)[]; "renderers"?: (Renderer)[]; "commands"?: (Command)[]; [key: string]: unknown; };
export type Contract = Surface;
