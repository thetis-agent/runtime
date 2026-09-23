import type { SshGrant } from "../contracts/index.js";
import type { StoreMirror } from "./store.js";

/**
 * The per-user ssh grants: one document per person, `{ ssh: [ { key, hosts } ] }`.
 *
 * A grant names one key file on the host, never a directory. A host `~/.ssh` holds unrelated credentials
 * -- a deploy key, a cloud key, a personal key -- so a directory grant would hand all of them to a fence
 * that needed one. The key itself is read by the kernel and loaded into that fence's agent; it is never
 * bound anywhere the fence can reach. Who may set a grant is the caller's decision; what a list looks
 * like when it arrives, and the keys the host makes, are @thetis/host-grants's.
 */
export class SshStore {
  constructor(private readonly docs: StoreMirror<{ ssh: SshGrant[] }>) {}

  /** A copy of one person's grants; empty when none. */
  get(user: string): SshGrant[] {
    return (this.docs.get(user)?.ssh ?? []).map((g) => ({ key: g.key, ...(g.hosts?.length ? { hosts: [...g.hosts] } : {}) }));
  }

  all(): Record<string, SshGrant[]> {
    return Object.fromEntries(this.docs.all().map(([u]) => [u, this.get(u)]));
  }

  /** Replaces one person's grants; an empty list removes the document. */
  set(user: string, grants: SshGrant[]): void {
    if (grants.length) this.docs.set(user, { ssh: grants.map((g) => ({ key: g.key, ...(g.hosts?.length ? { hosts: [...g.hosts] } : {}) })) });
    else this.docs.delete(user);
  }
}

/** Every known_hosts line of a grant list, deduplicated, in the order they were granted. The fence writes it when it opens. */
export function knownHostsOf(grants: SshGrant[]): string {
  const lines: string[] = [];
  for (const g of grants) for (const h of g.hosts ?? []) if (!lines.includes(h)) lines.push(h);
  return lines.length ? `${lines.join("\n")}\n` : "";
}
