// What a configuration change can reach without a new process, and how to apply the part that can.
//
// A value's lifetime is a property of how its consumer reads it, not of what it is about. `model` is read
// on every turn, `fence.limits` on every fence open, `door.port` once, at boot, into a bound socket. Those
// three want three different answers to "I edited the file, now what", and for a long time the only record
// of which was which was a table in a document -- which drifted, because nothing checked it.
//
// So a tier is declared per key and the reload derives its behaviour from the declaration. A key nobody
// declared is treated as `boot`, the safe answer: a reload that quietly ignored an undeclared key would be
// the failure this is meant to remove. The point is not that everything becomes live. It is that a reload
// can say which keys it applied and which are still waiting on a process, instead of looking like it
// worked either way.
export type ConfigTier = "boot" | "dispatch" | "fence";

/** A change the reload could not apply, and what it is waiting for. */
export interface TierReport {
  /** Applied at once: the consumer reads these on every dispatch. */
  dispatch: string[];
  /** Applied by closing the fences, which reopen with the new settings. */
  fence: string[];
  /** Read once by `thetis serve` and held for its life; these need a new daemon process. */
  boot: string[];
}

/** The dotted paths whose values differ, deepest first, comparing plain data by value. */
export function changedKeys(before: unknown, after: unknown, prefix = ""): string[] {
  if (before === after) return [];
  const bothObjects = isPlainObject(before) && isPlainObject(after);
  if (!bothObjects) return same(before, after) ? [] : [prefix];
  const keys = new Set([...Object.keys(before as object), ...Object.keys(after as object)]);
  const changed: string[] = [];
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    changed.push(...changedKeys((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key], path));
  }
  return changed;
}

/**
 * The tier of one key: the declaration for the longest prefix of its path that has one. `fence.limits.pids`
 * is answered by `fence.limits` if that is declared, then by `fence`, and finally by `boot` -- an
 * undeclared key is never assumed to be live.
 */
export function tierOf(path: string, tiers: Record<string, ConfigTier>): ConfigTier {
  const parts = path.split(".");
  for (let n = parts.length; n > 0; n--) {
    const tier = tiers[parts.slice(0, n).join(".")];
    if (tier) return tier;
  }
  return "boot";
}

/** Every changed key, grouped by what it takes to put it into service. */
export function classifyChanges(before: unknown, after: unknown, tiers: Record<string, ConfigTier>): TierReport {
  const report: TierReport = { dispatch: [], fence: [], boot: [] };
  for (const path of changedKeys(before, after)) report[tierOf(path, tiers)].push(path);
  return report;
}

/**
 * Copies `after` into `before` **in place**, so that every holder of `before` or of any object inside it
 * sees the new values without being handed a new reference.
 *
 * That is the whole mechanism behind the `dispatch` tier. The kernel binds one configuration object at
 * boot and every consumer keeps it -- the runner reads `config.model` on each turn, the enumerator reads
 * `config.phases`, the fence holds `config.fence` -- so replacing the object would update nobody, and
 * mutating it updates everybody, with no call site to change. Keys absent from `after` are removed, so a
 * key deleted from the file goes back to its default rather than lingering.
 */
export function applyInPlace(before: Record<string, unknown>, after: Record<string, unknown>): void {
  for (const key of Object.keys(before)) if (!(key in after)) delete before[key];
  for (const [key, value] of Object.entries(after)) {
    const current = before[key];
    if (isPlainObject(current) && isPlainObject(value)) applyInPlace(current as Record<string, unknown>, value as Record<string, unknown>);
    else before[key] = value;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep value equality, for the places `changedKeys` stops recursing: inside an array.
 *
 * Objects have to be compared by value here too, or an array of them never equals itself and every reload
 * reports a change that did not happen. `packages["@thetis/marketplace"].registries` is one such array,
 * and it named itself as changed on a reload of an untouched file until this compared objects properly.
 */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => k in b && same(a[k], b[k]));
  }
  return false;
}
