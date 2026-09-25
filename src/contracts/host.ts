// Host packages: admin features that need the host itself -- its filesystem, its key store, the records the
// kernel keeps -- and so cannot run in a fence. The host process loads one by name the way it loads a storage
// driver: from the shipped or the promoted packages, never from a userspace, and its entry is imported again
// whenever its file changes, so a change is live on the next call. The kernel dispatches `host.<name>.<export>`
// from the operator channel to the export, after checking that the caller is an admin or the operator, and
// journals the call. Nothing about mounts, keys or any other feature is known to the kernel.
import type { Mount, SshGrant, UserRecord } from "./identity.js";

/** The package type of a host package. Chosen by `thetis.host.name`; never installed into a fence. */
export const HOST_TYPE = "host";

/** One per-person record the kernel keeps and a host package may read and replace: a list per user id. */
export interface GrantRecords<T> {
  /** A copy of one person's list; empty when none. */
  get(user: string): T[];
  all(): Record<string, T[]>;
  /** Replaces one person's list; an empty list removes it. The fence reads it when it next opens. */
  set(user: string, value: T[]): void;
}

/** What a host method receives besides its arguments. */
export interface HostEnv {
  /** The service-plane data directory: where a host package keeps what it holds for a fence, under a directory of its own. */
  home: string;
  /** The runtime checkout: the code the daemon runs and every fence loads, with the packages submodule under it. */
  root: string;
  users: {
    get(id: string): UserRecord | undefined;
    list(): UserRecord[];
  };
  records: {
    mounts: GrantRecords<Mount>;
    ssh: GrantRecords<SshGrant>;
  };
  /** One row in the service plane's journal. `actor` defaults to who called the method. */
  journal(row: { kind: string; target: string; data?: Record<string, unknown>; actor?: string }): void;
  /** Closes and reopens a person's fence, so a changed grant reaches it; its services start again. */
  reloadFence(user: string): Promise<void>;
  log(line: string): void;
}

/**
 * The export a `host.<name>.<export>` call names. `args` is the call's object as it arrived, with `actor`
 * set to the admin who called when the call came through a fence, and absent for the operator at the socket.
 */
export type HostMethod = (args: Record<string, unknown>, env: HostEnv) => Promise<unknown>;
