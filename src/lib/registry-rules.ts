// What a registry accepts, declared by the registry itself in `thetis-registry.json` at its root:
//
//   { "scopes": ["@thetis"] }
//
// The rule lives in the repository because the repository is what every reader has in hand: the publisher's
// clone, the marketplace's mirror, the installation's shipped tree and the repository's own hooks and CI all
// read the same file, so no two of them can disagree about it. A registry with no file accepts any scope.
// A file that cannot be read as a rule is an error everywhere, never "no rule": a rule that quietly is not
// there is how a personal package ended up in the tree every installation ships.

export const REGISTRY_RULES_FILE = "thetis-registry.json";

export interface RegistryRules {
  /** The scopes a package name may have here, such as `@thetis`. Absent: any scope. */
  scopes?: string[];
}

/** The rules in a `thetis-registry.json`, or `{}` when there is no file. Throws, naming the file, when the text is not a rule. */
export function parseRegistryRules(text: string | undefined): RegistryRules {
  if (text === undefined) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${REGISTRY_RULES_FILE} is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${REGISTRY_RULES_FILE} is not an object; it is { "scopes": ["@scope", ...] }`);
  const scopes = (raw as { scopes?: unknown }).scopes;
  if (scopes === undefined) return {};
  if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === "string" && /^@[a-z0-9][a-z0-9._-]*$/.test(s))) {
    throw new Error(`${REGISTRY_RULES_FILE}: scopes is not a list of scopes such as "@thetis"`);
  }
  return { scopes };
}

/** Why `name` may not be in a registry with these rules, or undefined when it may. */
export function registryRefusal(rules: RegistryRules, name: string): string | undefined {
  if (!rules.scopes) return undefined;
  const scope = name.startsWith("@") ? name.split("/")[0] : "";
  if (rules.scopes.includes(scope)) return undefined;
  return `${name} is not in ${rules.scopes.join(" or ")}, the only ${rules.scopes.length === 1 ? "scope" : "scopes"} this registry accepts (${REGISTRY_RULES_FILE})`;
}
