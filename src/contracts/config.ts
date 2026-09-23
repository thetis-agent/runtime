import type { z } from "zod";
import type { ConfigTypeSchema, ConfigLayerSchema, ConfigDeclSchema, ConfigKeyStateSchema, ConfigReportSchema } from "./schemas/config.js";
// Per-package configuration: what a package declares about its keys, and how the kernel describes the state
// of each key to a person, a panel or the model. Values themselves travel to package code as `config`.

export type ConfigType = z.infer<typeof ConfigTypeSchema>;

/** Where a value came from: a declared default, `thetis.config.json`, the system store, or a person's own store. */
export type ConfigLayer = z.infer<typeof ConfigLayerSchema>;

/** One key a package declares under `thetis.config`. Undeclared keys are allowed and untyped. */
export type ConfigDecl = z.infer<typeof ConfigDeclSchema>;

/** The state of one key as the kernel reports it. Secrets carry no `value`. */
export type ConfigKeyState = z.infer<typeof ConfigKeyStateSchema>;

/** What `config.show` answers: every key of a package, and one sentence about the package. */
export type ConfigReport = z.infer<typeof ConfigReportSchema>;
