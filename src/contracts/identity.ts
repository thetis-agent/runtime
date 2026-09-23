// Who: users and their roles, the userspace each one owns, and the sessions inside it.
import type { HarnessState } from "./pipeline.js";
import type { Message } from "./messages.js";

export const SYSTEM_USER = "_system";

export type UserRole = "system" | "admin" | "user";
export type UserStatus = "active" | "suspended";

export interface UserRecord {
  id: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}

/** The part of a user record a gateway learns from a login token. */
export interface AuthUser {
  id: string;
  role: UserRole;
}

/** A host path an admin has granted into one person's fence, bound at the same path. */
export interface Mount {
  path: string;
  mode: "rw" | "ro";
}

/**
 * An ssh credential an admin has granted to one person's fence. `key` is a host path the kernel reads; it
 * is loaded into that fence's own agent and is never bound anywhere the fence can reach, so the fence may
 * use the credential while it is open and can never copy it. `hosts` are the `known_hosts` lines vouched
 * for alongside it, because a fence with a key and no known host cannot connect to anything.
 */
export interface SshGrant {
  key: string;
  hosts?: string[];
}

export interface Userspace {
  id: string;
  root: string;
  home: string;
  store: string;
  sessions: string;
  /** Sockets a service of this userspace listens on. The door reaches them from the host. */
  run: string;
  /** Host paths bound into the fence besides the userspace. Absent or empty: none. */
  mounts?: Mount[];
  /** ssh credentials this fence's own agent holds. Absent or empty: no agent, and no ssh. */
  ssh?: SshGrant[];
}

export interface SessionInfo {
  id: string;
  user: string;
  parent?: string;
}

export interface SessionRecord {
  id: string;
  user: string;
  parent?: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  conversation: Message[];
  harness: HarnessState;
  /** The turn in progress, written when it starts and removed when it ends; a record still carrying one was interrupted. */
  turn?: { id: string; startedAt: string; input?: string; messages?: Message[] };
}

/** What a list of sessions says about each without opening its record. `first` and `last` are clipped to 200 characters. */
export interface SessionSummaryRef {
  id: string;
  user: string;
  parent?: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  /** The first user message, or "". */
  first: string;
  /** The last message that said something: a user message, or an assistant message with content; or "". */
  last: string;
  /** A turn is in progress right now. */
  running: boolean;
}
