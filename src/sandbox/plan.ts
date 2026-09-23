// What a fence mounts, as data rather than as a sequence of calls.
//
// Bubblewrap applies its mount options in the order they are given, and a mount at a path lands on top of
// whatever was mounted beneath it. Building that list by pushing flags in the right order works until the
// paths move, and then it fails silently: the flag is still there, still accepted, and simply has no
// effect. That is not a hypothetical. `fence.hidden` masks `$THETIS_HOME` with an empty tmpfs, and the
// mask was pushed before the read-only binds of the operating system; when the data directory moved under
// `/opt` on 2026-09-18 the later `--ro-bind /opt /opt` landed on top of it and the mask stopped existing.
// Every fence could then read the service plane -- the journal, the password file, every other userspace --
// and connect to the control socket. Nothing failed, no test broke, and the flag was still in the command
// line. The cgroup destination and `--unshare-cgroup` came apart the same way twice before that.
//
// So the plan is built declaratively, ordered by one rule, and rendered last. The rule is that a shallower
// target is mounted before a deeper one, which is the only order in which every intent survives: a later
// mount can then only ever be *inside* an earlier one, never on top of it. A mask under a bound parent
// still applies, and a bind under a mask still shows through -- both verified against a real bubblewrap in
// `test/plan.test.ts`. Getting the order right is no longer something a reader has to hold in their head.
//
// Ordering answers "what lands on top of what". It does not answer "who wins" when one entry lands legally
// *inside* another and takes part of it away, which is how a read-only bind can eat a hole in a person's
// read-write mount. That is `resolveGrants`, below, and it cost the same kind of silence to find.
import { posix } from "node:path";

/** What one entry of the plan does. The names are the fence's vocabulary, not bubblewrap's spelling. */
export type IntentKind = "dev" | "proc" | "tmpfs" | "ro" | "rw" | "symlink";

export interface MountIntent {
  kind: IntentKind;
  /** Where it appears inside the fence. */
  target: string;
  /** The host path for `ro` and `rw`, or the link target for `symlink`. Not used by the others. */
  source?: string;
  /** Bubblewrap's `-try`: a source that is not there is skipped instead of failing the fence. */
  optional?: boolean;
  /** One phrase naming who asked for this, so a conflict report can say what collided with what. */
  why: string;
  /** A person's own mount, granted by an admin. The grant is authority, so nothing the fence adds for its
   * own reasons may quietly take part of it back: see `resolveGrants`. */
  grant?: boolean;
}

export interface PlanConflict {
  target: string;
  message: string;
}

/** How deep a path is, so the plan can be ordered parents-first. `/` is 0, `/opt` is 1. */
function depth(path: string): number {
  return posix.normalize(path).split("/").filter(Boolean).length;
}

/** Whether `path` lies strictly inside `root`. Both are absolute and normalized before the comparison. */
function isBelow(path: string, root: string): boolean {
  const p = posix.normalize(path);
  const r = posix.normalize(root);
  return p !== r && p.startsWith(r === "/" ? "/" : `${r}/`);
}

/**
 * The second way an intent can be lost, and the one the ordering rule cannot fix. Ordering by depth stops
 * an entry landing *on top of* another, but a deeper entry still lands *inside* an earlier one, and that
 * is a mount too: a read-only bind inside a person's read-write mount takes that subtree back, silently,
 * with both flags still in the command line and no conflict to report.
 *
 * It happened. `fence.readOnly` binds the checkout's `packages` and `node_modules` so a fence sees the
 * code it runs; a person granted `rw` over the checkout itself got a workspace where the two directories
 * they were most likely to edit were read-only, while `THETIS_MOUNTS`, the project page and the system
 * prompt all said `rw`. The agent discovered it, which is exactly the surprise a mount state is supposed
 * to prevent.
 *
 * So a grant wins over what the fence adds for its own convenience: a read-only bind of a host path at
 * its own path, inside a granted `rw` mount, is bound read-write instead. Two things are deliberately
 * left alone, because they are policy rather than convenience:
 *
 *  - anything behind a mask. A `tmpfs` between the grant and the bind is the fence hiding something
 *    inside a granted path -- the service plane under `$THETIS_HOME` -- and what shows through the mask
 *    is revealed on purpose and read-only. A grant over `/opt/zero` does not make the shared directory
 *    or the promoted packages writable.
 *  - a bind whose source is not its target. That is the fence putting one path somewhere else (the
 *    resolver, the ssh files, the cgroup), not the person's own directory, and the grant says nothing
 *    about it.
 */
export function resolveGrants(intents: MountIntent[]): MountIntent[] {
  const grants = intents.filter((i) => i.grant && i.kind === "rw");
  if (!grants.length) return intents;
  const masks = intents.filter((i) => i.kind === "tmpfs");
  return intents.map((intent) => {
    if (intent.kind !== "ro" || intent.grant || intent.source !== intent.target) return intent;
    const grant = grants.find((g) => isBelow(intent.target, g.target));
    if (!grant) return intent;
    const masked = masks.some((m) => (m.target === intent.target || isBelow(intent.target, m.target)) && isBelow(m.target, grant.target));
    if (masked) return intent;
    return { ...intent, kind: "rw" as const, why: `${intent.why}, read-write inside the mount ${grant.target}` };
  });
}

/**
 * The plan in the order bubblewrap has to receive it: shallower targets first, and entries of equal depth
 * in the order they were declared. Ordering by depth is what makes every intent survive, because a mount
 * can then only land inside an earlier one and never over it. Two cases the fence depends on, and which
 * the previous hand-ordered list got wrong in one direction or the other:
 *
 * - `/opt` read-only, then a tmpfs over `$THETIS_HOME` beneath it: the mask applies, and the service plane
 *   is hidden even though its parent was bound first.
 * - that tmpfs, then a read-only bind of the promoted packages inside it: the packages show through the
 *   mask, because the bind is deeper and therefore later.
 *
 * Declaration order still decides between entries at the same depth, which is how a person's `rw` mount
 * beats a read-only bind of the same path: mounts are declared last.
 */
export function orderIntents(intents: MountIntent[]): MountIntent[] {
  return intents.map((intent, at) => ({ intent, at })).sort((a, b) => depth(a.intent.target) - depth(b.intent.target) || a.at - b.at).map((e) => e.intent);
}

/**
 * What an ordered plan cannot deliver. One entry landing on top of another is structurally impossible once
 * the plan is ordered -- a later entry is deeper, so it lands inside its predecessor rather than over it --
 * and one landing inside a grant and taking it back is `resolveGrants`'s. That leaves two things worth
 * saying out loud: two entries claiming the same path, where only the last one happens, and an entry that
 * names no source when its kind needs one.
 */
export function validateIntents(ordered: MountIntent[]): PlanConflict[] {
  const conflicts: PlanConflict[] = [];
  const seen = new Map<string, MountIntent>();
  for (const intent of ordered) {
    const target = posix.normalize(intent.target);
    const earlier = seen.get(target);
    if (earlier && !(earlier.kind === intent.kind && earlier.source === intent.source)) {
      conflicts.push({ target, message: `${earlier.kind} (${earlier.why}) is replaced by ${intent.kind} (${intent.why}); only the second one happens` });
    }
    if ((intent.kind === "ro" || intent.kind === "rw" || intent.kind === "symlink") && !intent.source) {
      conflicts.push({ target, message: `${intent.kind} (${intent.why}) names no source` });
    }
    seen.set(target, intent);
  }
  return conflicts;
}

/** The bubblewrap options for one ordered plan. Rendering is the last step and makes no decisions. */
export function renderIntents(ordered: MountIntent[]): string[] {
  const args: string[] = [];
  for (const i of ordered) {
    switch (i.kind) {
      case "dev":
        args.push("--dev", i.target);
        break;
      case "proc":
        args.push("--proc", i.target);
        break;
      case "tmpfs":
        args.push("--tmpfs", i.target);
        break;
      case "symlink":
        args.push("--symlink", i.source as string, i.target);
        break;
      case "ro":
        args.push(i.optional ? "--ro-bind-try" : "--ro-bind", i.source as string, i.target);
        break;
      case "rw":
        args.push(i.optional ? "--bind-try" : "--bind", i.source as string, i.target);
        break;
    }
  }
  return args;
}
