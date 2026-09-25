// The registry's document shape changed once, on 2026-09-25: a record used to hold one owner, one source and
// a list of userspaces, so two people holding the same name from different sources or at different pins
// shared a single source field and the later install won -- clone pruning then deleted the earlier person's
// clone, and the maintainer of a package lost Promote and Delete the moment somebody else installed it. A
// record now holds one entry per workspace and no owner at all. This is the mechanism that reads the old
// shape into the new; the kernel's registry calls it once per document when it opens.
import type { InstalledRecord, PackageInstall, PackageRecord } from "../contracts/index.js";
import { LegacyPackageRecordSchema } from "../contracts/schemas/packages.js";

/** A stored document in the current shape. A legacy document's one source and displacement apply to every workspace it listed, which is what they meant. */
export function upgradeRecord(doc: unknown): PackageRecord {
  if (doc && typeof doc === "object" && "installs" in doc) return doc as PackageRecord;
  const { name, version, type, source, userspaces, everyone, forkedFrom, replaced, replacedSource } = LegacyPackageRecordSchema.parse(doc);
  const install: PackageInstall = { version, type, source, ...(replaced ? { replaced, ...(replacedSource ? { replacedSource } : {}) } : {}) };
  return { name, ...(everyone ? { everyone: true } : {}), ...(forkedFrom ? { forkedFrom } : {}), installs: Object.fromEntries(userspaces.map((u) => [u, install])) };
}

/** One workspace's view of a record: its own entry with the facts shared by every workspace. */
export function installedView(rec: PackageRecord, own: PackageInstall): InstalledRecord {
  return { name: rec.name, ...own, ...(rec.everyone ? { everyone: true } : {}), ...(rec.forkedFrom ? { forkedFrom: rec.forkedFrom } : {}) };
}

/** The record with one workspace's entry replaced. A displacement the workspace recorded before survives a re-record that says nothing about one, because relinking and restoring say nothing about it. */
export function withInstall(existing: PackageRecord | undefined, name: string, userspace: string, install: PackageInstall, forkedFrom?: PackageRecord["forkedFrom"]): PackageRecord {
  const prev = existing?.installs[userspace];
  const kept = prev?.replaced && !install.replaced ? { replaced: prev.replaced, ...(prev.replacedSource ? { replacedSource: prev.replacedSource } : {}) } : {};
  const origin = forkedFrom ?? existing?.forkedFrom;
  return { name, ...(existing?.everyone ? { everyone: true } : {}), ...(origin ? { forkedFrom: origin } : {}), installs: { ...existing?.installs, [userspace]: { ...install, ...kept } } };
}
