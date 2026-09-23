// Per-package configuration: what a package declares about its keys, and how the kernel describes the state
// of each key to a person, a panel or the model. Values themselves travel to package code as `config`.

export type ConfigType = "string" | "number" | "boolean" | "object" | "array";

/** Where a value came from: a declared default, `thetis.config.json`, the system store, or a person's own store. */
export type ConfigLayer = "default" | "file" | "system" | "user";

/** One key a package declares under `thetis.config`. Undeclared keys are allowed and untyped. */
export interface ConfigDecl {
  type: ConfigType;
  /** Kept in a private namespace; never shown, never echoed by a tool, named but not valued in the journal. */
  secret?: boolean;
  /** The package cannot work without it; the panel and the CLI say so before the model finds out. */
  required?: boolean;
  default?: unknown;
  /** `system`: only an admin sets it, at the system layer; a person's own layer never overrides it. Default `user`. */
  scope?: "system" | "user";
  /** One sentence for the form. */
  help?: string;
}

/** The state of one key as the kernel reports it. Secrets carry no `value`. */
export interface ConfigKeyState {
  key: string;
  /** `set`: a value reaches the package; `missing`: a `${VAR}` did not resolve, or a required key has nothing; `unset`: nothing anywhere, not required. */
  state: "set" | "missing" | "unset";
  /** Absent for a secret, unless the stored value is a pure `${VAR}` reference, which is shown as the reference. */
  value?: unknown;
  /** True when the value was left out because the key is a secret. */
  redacted?: true;
  source?: ConfigLayer;
  /** The package whose configuration supplied the value, when it was an origin of this fork and not the package itself. */
  inheritedFrom?: string;
  /** The `${VAR}` names in this key's value that did not resolve. */
  missing?: string[];
  secret: boolean;
  declared: boolean;
  type?: ConfigType;
  required?: boolean;
  scope?: "system" | "user";
  help?: string;
}

/** What `config.show` answers: every key of a package, and one sentence about the package. */
export interface ConfigReport {
  package: string;
  /** The user whose layer was included, or absent for the system view. */
  user?: string;
  /** The fork chain this package inherits from, origin first. Empty for a package that is not a fork. */
  inherits: string[];
  keys: ConfigKeyState[];
  /** One plain sentence: "every key is set", "token is required and not set", "apiKey: OPENROUTER_API_KEY is not in the environment". */
  summary: string;
  /** True when a required key is missing or a reference did not resolve. */
  broken: boolean;
}
