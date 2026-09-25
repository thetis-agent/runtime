import { z } from "zod";
import { ConfigDeclsSchema } from "./config.js";
import { UserRoleSchema } from "./identity.js";
import { BenchDeclSchema } from "./bench.js";

export const ScopedPackageNameSchema = z.string().regex(/^@[a-z0-9-]+\/[a-z0-9._-]+$/, "package name must be scoped (@scope/name)");
export const StepDeclSchema = z.looseObject({ id: z.string(), phase: z.string(), export: z.string() });
export const ToolDeclSchema = z.looseObject({
  name: z.string(), description: z.string(), parameters: z.record(z.string(), z.unknown()).default({}), export: z.string(),
});
export const ForkOriginSchema = z.object({ name: ScopedPackageNameSchema, version: z.string() });
export const ForkStatusSchema = ForkOriginSchema.extend({ shipped: z.string().optional(), identical: z.boolean().optional(), everyone: z.boolean().optional() });
export const PackageSourceSchema = z.object({ kind: z.enum(["system", "local", "git"]), ref: z.string() });
/** Why a system package is everyone's default: the installation's configuration, its promotion, or an admin's mark. Only the mark can be taken back. */
export const EveryoneBySchema = z.enum(["config", "promoted", "marked"]);

export const UiEntryDeclSchema = z.looseObject({
  id: z.string(), label: z.string().optional(), icon: z.string().optional(), hint: z.string().optional(),
  wide: z.boolean().optional(), note: z.string().optional(), under: z.string().optional(),
  /** Least role allowed to see the entry; omitted means any signed-in person. */
  role: UserRoleSchema.optional(), order: z.number().optional(),
});
export const UiCommandDeclSchema = z.looseObject({
  verb: z.string(), export: z.string(), label: z.string().optional(), role: UserRoleSchema.optional(), stream: z.boolean().optional(),
});
export const UiDeclSchema = z.looseObject({
  dir: z.string().optional(), entry: z.string().optional(), style: z.string().optional(),
  dock: z.array(UiEntryDeclSchema).optional(), panel: z.array(UiEntryDeclSchema).optional(),
  places: z.array(UiEntryDeclSchema).optional(), sidebar: z.array(UiEntryDeclSchema).optional(),
  chips: z.array(UiEntryDeclSchema).optional(), composer: z.array(UiEntryDeclSchema).optional(),
  shelf: z.array(UiEntryDeclSchema).optional(), statusbar: z.array(UiEntryDeclSchema).optional(),
  commands: z.array(UiCommandDeclSchema).optional(),
});
export const ThetisFieldSchema = z.looseObject({
  type: z.string(), steps: z.array(StepDeclSchema).optional(), tools: z.array(ToolDeclSchema).optional(),
  export: z.string().optional(), service: z.looseObject({ export: z.string() }).optional(),
  publish: z.array(z.looseObject({ port: z.number().int().min(1).max(65535), to: z.string() })).optional(),
  /** A fork records its origin so updates and uninstall can restore the original package. */
  forkedFrom: ForkOriginSchema.optional(),
  /** Optional contributions interpreted by extension packages. */
  bench: BenchDeclSchema.optional(), ui: UiDeclSchema.optional(),
  skills: z.string().optional(), config: ConfigDeclsSchema.optional(), host: z.looseObject({ name: z.string() }).optional(),
});
export const ManifestSchema = z.looseObject({
  name: ScopedPackageNameSchema, version: z.string(), description: z.string().optional(), main: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).optional(), peerDependencies: z.record(z.string(), z.string()).optional(),
  scripts: z.record(z.string(), z.string()).optional(), thetis: ThetisFieldSchema,
});
export const PackageInfoSchema = z.object({
  name: z.string(), version: z.string(), type: z.string(), description: z.string(), root: z.string(), thetis: ThetisFieldSchema,
  everyone: z.boolean().optional(), everyoneBy: EveryoneBySchema.optional(), forkedFrom: ForkOriginSchema.optional(), fork: ForkStatusSchema.optional(),
  replaced: z.string().optional(), source: PackageSourceSchema.optional(),
  /** Version loaded by an open fence; a different on-disk version requires a reload. */
  loadedVersion: z.string().optional(),
});
/** One workspace's copy of a package: what it is, where it came from, and what it displaced. */
export const PackageInstallSchema = z.object({ version: z.string(), type: z.string(), source: PackageSourceSchema, replaced: z.string().optional(), replacedSource: PackageSourceSchema.optional() });
/**
 * One document per package name: the workspaces holding it, each with its own copy. There is no owner. A
 * scope is a namespace and nothing more; `@thetis` is the installation's because the kernel resolves that
 * one by name on disk, and every other scope is a label a person chose. Two people holding the same name
 * from different sources, or at different pins, are two entries here and never overwrite each other.
 */
export const PackageRecordSchema = z.object({ name: z.string(), everyone: z.boolean().optional(), forkedFrom: ForkOriginSchema.optional(), installs: z.record(z.string(), PackageInstallSchema) });
/** A record as one workspace reads it: its own copy, with the facts the record holds for every workspace. */
export const InstalledRecordSchema = PackageInstallSchema.extend({ name: z.string(), everyone: z.boolean().optional(), forkedFrom: ForkOriginSchema.optional() });
/** The shape written before 2026-09-25: one owner and one source for every workspace. Read once and rewritten. */
export const LegacyPackageRecordSchema = z.object({
  name: z.string(), version: z.string(), type: z.string(), owner: z.string(), source: PackageSourceSchema,
  userspaces: z.array(z.string()), everyone: z.boolean().optional(), forkedFrom: ForkOriginSchema.optional(),
  replaced: z.string().optional(), replacedSource: PackageSourceSchema.optional(),
});
export const DeletedPackageSchema = z.object({ name: z.string(), path: z.string(), restored: z.string().optional() });
