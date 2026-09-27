// The one-time cleanup of `thetis.config.json`. An older `thetis init` wrote every default into the file, and
// values an admin later moved into the store (a key, a registry list) stayed behind in it. Both are dead weight
// that reads like configuration: a default written down stops following the default when it changes, and a
// file value the store shadows is never used but is still the first place a person looks. This finds them;
// the caller decides whether to write the result. Nothing here reads a file or the store.
import { isDeepStrictEqual } from "node:util";

/** One value the tidy takes out, by its dotted path, and why it is safe to. */
export interface TidyRemoval {
  path: string;
  why: "default" | "store";
}

export interface TidyInput {
  /** The file as it is on disk, parsed. */
  file: Record<string, unknown>;
  /** The kernel's defaults for the keys a file may carry. */
  defaults: Record<string, unknown>;
  /**
   * The kernel keys `loadConfig` merges one key at a time over their default (`door`, `fence`, ...), so a
   * sub-key equal to its default can go on its own. Every other key replaces its default whole, and a part of it
   * cannot be taken out without changing what the rest means.
   */
  merged: string[];
  /** The declared default of one package key, `undefined` when it declares none. */
  packageDefault(name: string, key: string): unknown;
  /** True when the store's system layer holds this package key over the file's value, which then is never read. */
  shadowed(name: string, key: string, value: unknown): boolean;
}

export interface TidyResult {
  /** The file with the removals made. */
  next: Record<string, unknown>;
  removed: TidyRemoval[];
}

/** What can come out of the file without changing any value the installation runs on. */
export function tidyConfig(input: TidyInput): TidyResult {
  const removed: TidyRemoval[] = [];
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.file)) {
    if (key === "packages") continue;
    if (!(key in input.defaults)) {
      next[key] = value;
      continue;
    }
    const kept = input.merged.includes(key) ? withoutDefaults(value, input.defaults[key], key, removed) : isDeepStrictEqual(value, input.defaults[key]) ? undefined : value;
    if (kept === undefined && !input.merged.includes(key)) removed.push({ path: key, why: "default" });
    if (kept !== undefined) next[key] = kept;
  }
  const packages: Record<string, Record<string, unknown>> = {};
  for (const [name, doc] of Object.entries(isPlain(input.file.packages) ? input.file.packages : {})) {
    if (!isPlain(doc)) continue;
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(doc)) {
      const path = `packages.${name}.${key}`;
      if (input.shadowed(name, key, value)) removed.push({ path, why: "store" });
      else if (input.packageDefault(name, key) !== undefined && isDeepStrictEqual(value, input.packageDefault(name, key))) removed.push({ path, why: "default" });
      else kept[key] = value;
    }
    if (Object.keys(kept).length) packages[name] = kept;
  }
  if (Object.keys(packages).length) next.packages = packages;
  return { next, removed };
}

/** A merged value with every part equal to its default taken out; undefined when nothing is left. */
function withoutDefaults(value: unknown, fallback: unknown, path: string, removed: TidyRemoval[]): unknown {
  if (isDeepStrictEqual(value, fallback)) {
    removed.push({ path, why: "default" });
    return undefined;
  }
  if (!isPlain(value) || !isPlain(fallback)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    const kept = key in fallback ? withoutDefaults(inner, fallback[key], `${path}.${key}`, removed) : inner;
    if (kept !== undefined) out[key] = kept;
  }
  return Object.keys(out).length ? out : undefined;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
