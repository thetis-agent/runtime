import type { InstalledRecord, PackageInstall, PackageRecord } from "../../contracts/index.js";
import { installedView, upgradeRecord, withInstall } from "../../lib/registry-record.js";
import type { StoreMirror } from "../../lib/store.js";

/**
 * Service-plane record of what packages exist and where they are installed. One document per package name,
 * holding one entry per workspace: that workspace's version, source and what it displaced. Nothing here says
 * who a package belongs to -- a scope is a namespace, and two workspaces holding the same name are two
 * entries, each answering for itself.
 */
export class PackageRegistry {
  constructor(private readonly records: StoreMirror<PackageRecord>) {
    // Documents written in the older one-owner shape are rewritten the first time the registry opens on them.
    for (const [key, doc] of records.all()) {
      const up = upgradeRecord(doc);
      if (up !== doc) records.set(key, up);
    }
  }

  get(name: string): PackageRecord | undefined {
    return this.records.get(name);
  }

  all(): PackageRecord[] {
    return this.records.all().map(([, r]) => r);
  }

  /** What one workspace holds of a package, or undefined when it does not have it. */
  installOf(name: string, userspace: string): InstalledRecord | undefined {
    const rec = this.records.get(name);
    const own = rec?.installs[userspace];
    return rec && own ? installedView(rec, own) : undefined;
  }

  installedIn(userspace: string): InstalledRecord[] {
    return this.all().flatMap((r) => (r.installs[userspace] ? [installedView(r, r.installs[userspace])] : []));
  }

  /** The workspaces holding a package. */
  holders(name: string): string[] {
    return Object.keys(this.records.get(name)?.installs ?? {});
  }

  record(name: string, userspace: string, install: PackageInstall, forkedFrom?: PackageRecord["forkedFrom"]): void {
    this.records.set(name, withInstall(this.records.get(name), name, userspace, install, forkedFrom));
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
    if (!rec?.installs[userspace]) return;
    const { [userspace]: gone, ...installs } = rec.installs;
    if (Object.keys(installs).length === 0) this.records.delete(name);
    else this.records.set(name, { ...rec, installs });
  }

  forgetUserspace(userspace: string): void {
    for (const name of this.records.keys()) this.unlink(name, userspace);
  }
}
