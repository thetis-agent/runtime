// Comparing two version strings, because a string comparison is wrong in the one place it matters: `0.10.0`
// sorts before `0.9.0` as text, and the tenth release of a line is exactly when a person stops reading the
// numbers and starts trusting the badge. There is no semver dependency in this repository and there is not
// going to be one for a function this size, so the rule is written here and tested here.
//
// It lives in `lib` rather than beside either of its callers because it had two homes and they disagreed.
// `@thetis/marketplace` decides whether a badge says a package is ahead of the registry, and
// `@thetis/package-publish` decides whether a publish is allowed at all. Those are the same question asked
// twice, and two implementations of it meant a badge could say a package was ahead while the publish refused
// it, months later, for a version neither author had thought about. One function, two callers.
//
// The rule is semver's, kept to what versions in this repository actually look like:
//   - the core is dot-separated, compared part by part as numbers, a missing part counting as 0, so
//     `1.2` and `1.2.0` are the same version;
//   - a part that is not a number is compared as text against the other side's, which is how a hand-written
//     `1.2.x` or a date-like version still orders itself instead of collapsing to 0;
//   - build metadata after `+` is not part of the version at all and is dropped before anything else;
//   - a prerelease (`1.2.0-rc.1`) is OLDER than the release it leads to (`1.2.0`), which is the one rule
//     people get backwards, and the one that decides whether `0.1.1-fork.1` counts as newer than `0.1.1`.
//     It does not. A fork's rewritten version is not unpublished work.
//   - prerelease identifiers are compared one by one: numeric ones numerically, and a numeric one is lower
//     than a text one; a prerelease that runs out of identifiers first is lower.
//
// **It is total: every pair of strings has an order, and nothing here answers "I cannot say".** That is the
// half of the merge that changed, and it changed deliberately. The publishing side used to answer null for
// anything its own `isVersion` rejected, which was defensible until you look at where the two sides get
// their input: a publish's own version is checked before it is written, but the version it is measured
// against is read out of somebody else's manifest in a registry, and a registry holding `1.2` is not this
// code's to reject. Null there fell through a `<= 0` test as though it meant "not newer", so a registry with
// one hand-written version in it refused every publish of that package for a reason the sentence got wrong.
// Ordering it is both the honest answer and the one that keeps the two callers saying the same thing.
//
// What this does *not* do is decide what a package may be published at. That is a stricter question with a
// stricter answer, and `@thetis/package-publish` keeps it: a version it writes must be a real semantic
// version. Lenient about what it reads, strict about what it writes.

/** The numeric value of an identifier, or undefined when it is not a plain run of digits. */
const numeric = (part: string): number | undefined => (/^\d+$/.test(part) ? Number(part) : undefined);

const cmp = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);

/** Splits `1.2.0-rc.1+build` into its core parts and its prerelease parts, dropping the build metadata. */
function parts(version: string): { core: string[]; pre: string[] } {
  const clean = String(version ?? "").trim().split("+")[0];
  const dash = clean.indexOf("-");
  const core = (dash === -1 ? clean : clean.slice(0, dash)).split(".");
  const pre = dash === -1 ? [] : clean.slice(dash + 1).split(".").filter(Boolean);
  return { core, pre };
}

/** Compares one prerelease against another. Empty means "no prerelease", which is the higher of the two. */
function comparePre(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    // The one that ran out of identifiers is the lower: `1.0.0-rc` precedes `1.0.0-rc.1`.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = numeric(x);
    const ny = numeric(y);
    if (nx !== undefined && ny !== undefined) {
      if (nx !== ny) return cmp(nx, ny);
      continue;
    }
    // A numeric identifier is always lower than a text one, whatever the text is.
    if (nx !== undefined) return -1;
    if (ny !== undefined) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** -1 when `a` is older than `b`, 1 when it is newer, 0 when the two name the same version. Never null. */
export function compareVersions(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.core.length, right.core.length); i++) {
    const x = left.core[i] ?? "0";
    const y = right.core[i] ?? "0";
    const nx = numeric(x);
    const ny = numeric(y);
    if (nx !== undefined && ny !== undefined) {
      if (nx !== ny) return cmp(nx, ny);
      continue;
    }
    if (x !== y) return x < y ? -1 : 1;
  }
  return comparePre(left.pre, right.pre);
}

/** True when `version` is strictly newer than `other`. The question every caller here is actually asking. */
export const isNewer = (version: string, other: string): boolean => compareVersions(version, other) > 0;
