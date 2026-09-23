import type { z } from "zod";
import type { UserRoleSchema, UserStatusSchema, UserRecordSchema, AuthUserSchema, SessionInfoSchema, SessionRecordSchema, SessionSummaryRefSchema } from "./schemas/identity.js";
// Who: users and their roles, the userspace each one owns, and the sessions inside it.

export const SYSTEM_USER = "_system";

export type UserRole = z.infer<typeof UserRoleSchema>;
export type UserStatus = z.infer<typeof UserStatusSchema>;

export type UserRecord = z.infer<typeof UserRecordSchema>;

/** The part of a user record a gateway learns from a login token. */
export type AuthUser = z.infer<typeof AuthUserSchema>;

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

export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export type SessionRecord = z.infer<typeof SessionRecordSchema>;

/** What a list of sessions says about each without opening its record. `first` and `last` are clipped to 200 characters. */
export type SessionSummaryRef = z.infer<typeof SessionSummaryRefSchema>;
