/** Generated from schema.json; defend wire compatibility (ADR 0006). Do not edit. */
export type Id = string;
export type Version = string;
export type Hash = string;
export type Frontmatter = { "name": Id; "description": string; "metadata"?: { "title"?: string; "tags"?: (string)[]; "related"?: (Id)[]; "universal"?: "true" | "false"; [key: string]: unknown; }; [key: string]: unknown; };
export type Card = { "id": Id; "pack": string; "version": Version; "path": string; "name": Id; "description": string; "tags": (string)[]; "related": (Id)[]; "universal": boolean; "bytes": number; "contentHash": Hash; "children": (Id)[]; [key: string]: unknown; };
export type Entry = { "id": Id; "pack": string; "version": Version; "path": string; "contentHash": Hash; "universal": boolean; "body"?: string; [key: string]: unknown; };
export type PinnedEntry = { "id": Id; "pack": string; "version": Version; "contentHash": Hash; [key: string]: unknown; };
export type RetrieveRequest = { "query": string; "k": number; "budget": number; "model": string; "activate"?: (Id)[]; [key: string]: unknown; };
export type RetrieveAnswer = { "entries": (Entry)[]; "dropped": (Id)[]; [key: string]: unknown; };
export type Contract = Frontmatter | Card | RetrieveRequest | RetrieveAnswer;
