/** Generated from schema.json; defend wire compatibility (ADR 0006). Do not edit. */
import type * as Registry from '../../contracts/registry/types.ts';
export type Layer = { "kind": "packages" | "lib" | "contracts" | "node_modules"; "directory": string; "pin": Registry.Pin; "source": string; [key: string]: unknown; };
export type Grant = { "source": string; "hash": string; "mount": string; [key: string]: unknown; };
export type Package = { "name": string; "version": string; "entry": string; "manifest": { [key: string]: unknown; }; [key: string]: unknown; };
export type Install = { "source": string; "hash": string; "mount": "/opt/thetis-runtime"; "aliases": (Grant)[]; "packages": (Package)[]; "layers": (Layer)[]; [key: string]: unknown; };
export type Profile = { "name": string; "version": string; "pins": ({ "kind": "packages" | "lib" | "contracts" | "node_modules"; "directory": string; "pin": Registry.Pin; [key: string]: unknown; })[]; [key: string]: unknown; };
export type Error = { "code": "invalid-args" | "io" | "budget" | "outside-roots" | "conflict" | "hash-mismatch" | "switching"; "message": string; [key: string]: unknown; };
export type Process = { "id": string; "state": string; "package": string; "entry": string; "owner": string; "scope": "person" | "deployment"; "profile": { [key: string]: unknown; }; "selection": (string)[]; "args"?: (string)[]; "settings"?: { [key: string]: { [key: string]: unknown; }; }; "services"?: ({ "id": string; "mount": string; [key: string]: unknown; })[]; "mounts"?: ({ "source": string; "path": string; "mode": "ro" | "rw"; "maximumBytes"?: number; [key: string]: unknown; })[]; "environment"?: boolean; "quotaBytes"?: number; "spawn"?: string; [key: string]: unknown; };
export type Recipe = { "root": string; "cgroup": string; "identity": { [key: string]: unknown; }; "source": string; "at": number; "discovery": Process; "targets": (Process)[]; [key: string]: unknown; };
export type Contract = Profile;
