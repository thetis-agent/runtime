/** Select at most one fix or improvement target within ADR 0049's proposed range, never a major, downgrade or prerelease. */
import { valid, gt, major, minor } from 'semver';

// ADR 0049 is Proposed: 'none' is the only value a caller may honour today, and every other
// value stays refused with one sentence naming this record until the operator accepts it.
// This module computes the 'fixes'/'improvements' answer regardless, so the tested code path
// is ready the day the record is accepted; the refusal lives at the caller that exposes policy.
export type Policy = 'none' | 'fixes' | 'improvements';

const releaseTag = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

/** True for a plain "vMAJOR.MINOR.PATCH" release version; excludes prerelease, build metadata and out-of-range numbers. */
function release(tag: string): boolean {
  return releaseTag.test(tag) && valid(tag) !== null;
}

function candidate(current: string, tag: string, sameMinor: boolean): boolean {
  return release(tag) && gt(tag, current) && major(tag) === major(current) && (!sameMinor || minor(tag) === minor(current));
}

function highest(tags: readonly string[]): string | undefined {
  return tags.reduce<string | undefined>((best, tag) => (best === undefined || gt(tag, best) ? tag : best), undefined);
}

export function select(current: string, tags: readonly string[], policy: Policy): string | undefined {
  if (!release(current)) return undefined;
  switch (policy) {
    case 'none': // the shipped default; ADR 0049 holds every other value refused until accepted
      return undefined;
    case 'fixes':
      return highest(tags.filter(tag => candidate(current, tag, true)));
    case 'improvements':
      return highest(tags.filter(tag => candidate(current, tag, false)));
    default: {
      const exhaustive: never = policy;
      return exhaustive;
    }
  }
}
