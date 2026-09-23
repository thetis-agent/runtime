import type { Mount } from "../contracts/index.js";
import type { StoreMirror } from "./store.js";

/**
 * The per-user mount lists: one document per person, `{ mounts: [ { path, mode } ] }`. Who may set one is
 * the caller's decision; what a list looks like when it arrives, and what the host holds at each path, is
 * @thetis/host-grants's. The fence reads the list when it opens.
 */
export class MountStore {
  constructor(private readonly docs: StoreMirror<{ mounts: Mount[] }>) {}

  /** A copy of one person's list; empty when none. */
  get(user: string): Mount[] {
    return (this.docs.get(user)?.mounts ?? []).map((m) => ({ ...m }));
  }

  all(): Record<string, Mount[]> {
    return Object.fromEntries(this.docs.all().map(([u]) => [u, this.get(u)]));
  }

  /** Replaces one person's list; an empty list removes the document. */
  set(user: string, mounts: Mount[]): void {
    if (mounts.length) this.docs.set(user, { mounts: mounts.map((m) => ({ path: m.path, mode: m.mode })) });
    else this.docs.delete(user);
  }
}
