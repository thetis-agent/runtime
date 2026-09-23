import { SYSTEM_USER, type UserRecord, type UserRole, type UserStatus } from "../contracts/index.js";
import { assert } from "../lib/error.js";
import { now } from "../lib/ids.js";
import type { StoreMirror } from "../lib/store.js";

const USER_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** Identity store: one record per user, in the `users` namespace of the service plane's store. */
export class UserStore {
  constructor(private readonly users: StoreMirror<UserRecord>) {
    if (!users.has(SYSTEM_USER)) users.set(SYSTEM_USER, { id: SYSTEM_USER, role: "system", status: "active", createdAt: now() });
  }

  list(): UserRecord[] {
    return this.users.all().map(([, u]) => u);
  }

  get(id: string): UserRecord | undefined {
    return this.users.get(id);
  }

  /** Returns the user only if it exists and may act; throws otherwise. */
  authorize(id: string): UserRecord {
    const user = this.users.get(id);
    assert(user, `unknown user: ${id}`, "unauthorized");
    assert(user.status === "active", `user ${id} is suspended`, "unauthorized");
    return user;
  }

  create(id: string, role: UserRole = "user"): UserRecord {
    assert(USER_ID.test(id), `invalid user id: ${id} (use [a-z][a-z0-9-]{0,31})`);
    assert(!this.users.has(id), `user already exists: ${id}`);
    const user: UserRecord = { id, role, status: "active", createdAt: now() };
    this.users.set(id, user);
    return user;
  }

  setStatus(id: string, status: UserStatus): UserRecord {
    return this.update(id, { status });
  }

  setRole(id: string, role: UserRole): UserRecord {
    assert(role !== "system", "the system role cannot be assigned");
    return this.update(id, { role });
  }

  remove(id: string): void {
    assert(id !== SYSTEM_USER, "the system user cannot be removed");
    assert(this.users.has(id), `unknown user: ${id}`);
    this.users.delete(id);
  }

  private update(id: string, patch: Partial<UserRecord>): UserRecord {
    const user = this.users.get(id);
    assert(user, `unknown user: ${id}`);
    assert(user.role !== "system", "the system user cannot be modified");
    const next = { ...user, ...patch };
    this.users.set(id, next);
    return next;
  }
}
