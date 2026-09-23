import type { PackageRecord } from "../../contracts/index.js";
import type { StoreMirror } from "../../lib/store.js";

/** Service-plane record of what packages exist, who owns them, and where they are installed. One document per package name. */
export class PackageRegistry {
  constructor(private readonly records: StoreMirror<PackageRecord>) {}

  get(name: string): PackageRecord | undefined {
    return this.records.get(name);
  }

  all(): PackageRecord[] {
    return this.records.all().map(([, r]) => r);
  }

  installedIn(userspace: string): PackageRecord[] {
    return this.all().filter((r) => r.userspaces.includes(userspace));
  }

  record(rec: Omit<PackageRecord, "userspaces">, userspace: string): PackageRecord {
    const existing = this.records.get(rec.name);
    const userspaces = existing ? existing.userspaces.filter((u) => u !== userspace) : [];
    // A promoted fork is installed into every userspace in turn; the first install that displaced something must not lose it.
    const kept = { ...(existing?.everyone ? { everyone: true } : {}), ...(existing?.replaced && !rec.replaced ? { replaced: existing.replaced, replacedSource: existing.replacedSource } : {}) };
    const next = { ...rec, userspaces: [...userspaces, userspace], ...kept };
    this.records.set(rec.name, next);
    return next;
  }

  /** Marks a package as the default for everyone, or unmarks it. */
  setEveryone(name: string, on: boolean): void {
    const rec = this.records.get(name);
    if (!rec) return;
    const { everyone, ...rest } = rec;
    this.records.set(name, on ? { ...rest, everyone: true } : rest);
  }

  /** The packages every new person is seeded with. */
  everyone(): string[] {
    return this.all().filter((r) => r.everyone).map((r) => r.name);
  }

  unlink(name: string, userspace: string): void {
    const rec = this.records.get(name);
    if (!rec) return;
    const userspaces = rec.userspaces.filter((u) => u !== userspace);
    if (userspaces.length === 0) this.records.delete(name);
    else this.records.set(name, { ...rec, userspaces });
  }

  forgetUserspace(userspace: string): void {
    for (const name of this.records.keys()) this.unlink(name, userspace);
  }
}
