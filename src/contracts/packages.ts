import type { z } from "zod";
import type { UiEntryDeclSchema, UiCommandDeclSchema, UiDeclSchema, StepDeclSchema, ToolDeclSchema, ForkOriginSchema, ForkStatusSchema, PackageSourceSchema, ThetisFieldSchema, ManifestSchema, PackageInfoSchema, PackageRecordSchema, DeletedPackageSchema } from "./schemas/packages.js";
// Packages: the manifest a package ships, what an installed package looks like, and the registry record.

export const SYSTEM_SCOPE = "@thetis";

export type StepDecl = z.infer<typeof StepDeclSchema>;

export type ToolDecl = z.infer<typeof ToolDeclSchema>;

/** The package a fork was copied from, as it was at the time of the copy. */
export type ForkOrigin = z.infer<typeof ForkOriginSchema>;

/**
 * A fork measured against the package it was copied from, as things stand now. `name` and `version` are the
 * origin as it was at the time of the copy, which is all a manifest records; the rest is what the kernel
 * can see by looking at the origin on disk. A fork that says nothing about its origin is a fork nobody can
 * leave: every later fix to the shipped package is invisible to whoever is holding it, and nothing says so.
 *
 * "Behind" is `shipped` differing from `version`: the origin has moved past the copy. `identical` is the
 * stronger case, and the one worth acting on -- the fork's files are the origin's files, so it is carrying
 * no change at all and is costing its owner every fix, past and future, for nothing.
 */
export type ForkStatus = z.infer<typeof ForkStatusSchema>;

export type PackageSource = z.infer<typeof PackageSourceSchema>;

/** One entry of a UI slot a package fills. `id` is unique per slot per package. */
export type UiEntryDecl = z.infer<typeof UiEntryDeclSchema>;

export type UiCommandDecl = z.infer<typeof UiCommandDeclSchema>;

/** What a package contributes to the web gateway's page. Read by @thetis/gateway-web; the kernel never reads it. */
export type UiDecl = z.infer<typeof UiDeclSchema>;

export type ThetisField = z.infer<typeof ThetisFieldSchema>;

export type Manifest = z.infer<typeof ManifestSchema>;

export type PackageInfo = z.infer<typeof PackageInfoSchema>;

export type PackageRecord = z.infer<typeof PackageRecordSchema>;

/** The result of deleting a package: what went, where its files were, and what came back in its place. */
export type DeletedPackage = z.infer<typeof DeletedPackageSchema>;
