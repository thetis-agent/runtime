// Packages: the manifest a package ships, what an installed package looks like, and the registry record.
import type { ConfigDecl } from "./config.js";
import type { BenchDecl } from "./bench.js";
import type { UserRole } from "./identity.js";
import type { JsonSchema } from "./messages.js";

export const SYSTEM_SCOPE = "@thetis";

export interface StepDecl {
  id: string;
  phase: string;
  export: string;
}

export interface ToolDecl {
  name: string;
  description: string;
  parameters: JsonSchema;
  export: string;
}

/** The package a fork was copied from, as it was at the time of the copy. */
export interface ForkOrigin {
  name: string;
  version: string;
}

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
export interface ForkStatus extends ForkOrigin {
  /** The version of the origin on disk here now. Absent when the origin is not here any more. */
  shipped?: string;
  /** True when the fork's files are the origin's files, apart from the name and version a fork rewrites. */
  identical?: boolean;
  /**
   * True when the origin is what every person here gets by default. Said to the holder of the fork, because
   * an admin making a package everyone's default cannot make it theirs -- the kernel refuses to install a
   * package over somebody's fork of it -- and the person would otherwise have no way of learning that the
   * thing they are standing apart from is now the house default.
   */
  everyone?: boolean;
}

export interface PackageSource {
  kind: "system" | "local" | "git";
  ref: string;
}

/** One entry of a UI slot a package fills. `id` is unique per slot per package. */
export interface UiEntryDecl {
  id: string;
  label?: string;
  /** SVG path data for a 20×20 viewBox, stroke-drawn like the shell's own icons. Dock and place entries. */
  icon?: string;
  hint?: string;
  /** Dock only: 620px instead of 360px. */
  wide?: boolean;
  /** Panel only: the sentence under the section title. */
  note?: string;
  /**
   * Panel only: the id of the section (a built-in one such as `packages`, or `<package>#<id>`) this entry
   * hangs pages under, instead of being a nav item itself. Its module answers `children()`; a click on a
   * child mounts the entry with `child` naming it.
   */
  under?: string;
  /** The least role that may see it. Default: any signed-in person. */
  role?: UserRole;
  /** Sort key among every package's entries of the same slot. Default 100. Ties keep install order. */
  order?: number;
}

export interface UiCommandDecl {
  /** ^[a-z][a-z0-9_-]{0,31}$ */
  verb: string;
  /** The function export of the package's `main`. */
  export: string;
  label?: string;
  /** The least role that may send it. Default: any signed-in person. */
  role?: UserRole;
  /** True when the export is a `UiStream`: the page subscribes to the verb instead of sending it. */
  stream?: boolean;
}

/** What a package contributes to the web gateway's page. Read by @thetis/gateway-web; the kernel never reads it. */
export interface UiDecl {
  /** Browser files, relative to the package root. Default "ui". Served at /<user>/ext/<package>/<path>. */
  dir?: string;
  /** ES module the shell imports after mounting, relative to `dir`. Its default export is `install(ext)`. */
  entry?: string;
  /** Stylesheet the shell links once, relative to `dir`. */
  style?: string;
  dock?: UiEntryDecl[];
  panel?: UiEntryDecl[];
  places?: UiEntryDecl[];
  /** Today only { id: "head" }: a slot at the top of the sidebar, under the brand. */
  sidebar?: UiEntryDecl[];
  chips?: UiEntryDecl[];
  composer?: UiEntryDecl[];
  shelf?: UiEntryDecl[];
  statusbar?: UiEntryDecl[];
  commands?: UiCommandDecl[];
}

export interface ThetisField {
  type: string;
  steps?: StepDecl[];
  tools?: ToolDecl[];
  export?: string;
  /** A long-running process the userspace agent starts when the fence opens and stops on uninstall. */
  service?: { export: string };
  publish?: { port: number; to: string }[];
  /** Set on a fork. Installing a fork replaces its origin in the userspace when the origin is installed there. */
  forkedFrom?: ForkOrigin;
  /** Opts the package into bench suites. Read by @thetis/bench on the host; the kernel never reads it. */
  bench?: BenchDecl;
  /** What the package adds to the web gateway's page. Read by @thetis/gateway-web; the kernel never reads it. */
  ui?: UiDecl;
  /** A directory of skills, relative to the package root, usually "skills". Read by @thetis/skills; the kernel never reads it. */
  skills?: string;
  /** The keys this package reads from its configuration. The kernel validates the shape, types a value on `config.set`, and reports each key's state. */
  config?: Record<string, ConfigDecl>;
  /** A package of type `host`: the name it answers to as `host.<name>.<export>` over the operator channel. See `HostEnv`. */
  host?: { name: string };
}

export interface Manifest {
  name: string;
  version: string;
  /** One sentence on what the package does. Shown wherever the package is listed. */
  description?: string;
  main?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  thetis: ThetisField;
}

export interface PackageInfo {
  name: string;
  version: string;
  type: string;
  description: string;
  root: string;
  thetis: ThetisField;
  /** True when every person gets this package: it is in `systemPackages["*"]`, promoted, or marked for everyone. */
  everyone?: boolean;
  forkedFrom?: ForkOrigin;
  /** A fork, against its origin as it stands now. Set by `packages.list` only; the plain `installed` list does not pay for it. */
  fork?: ForkStatus;
  /** The package this fork displaced in the userspace. An uninstall of the fork puts it back. */
  replaced?: string;
  /** Where this copy came from. A git source carries its pin, which is what tells you it is behind. */
  source?: PackageSource;
  /**
   * The version this package was at when the workspace's fence opened and read it. Absent when no fence is
   * open for that workspace, and never set on the system-wide registry record. `version` is what is on disk
   * now, so the two differing is a workspace that has not loaded the change: a reload applies it.
   */
  loadedVersion?: string;
}

export interface PackageRecord {
  name: string;
  version: string;
  type: string;
  owner: string;
  source: PackageSource;
  userspaces: string[];
  /** A shipped system package an admin made the default: every new person's userspace is seeded with it. */
  everyone?: boolean;
  forkedFrom?: ForkOrigin;
  /** What this fork displaced, and where that came from, so an uninstall of the fork restores it exactly. */
  replaced?: string;
  replacedSource?: PackageSource;
}

/** The result of deleting a package: what went, where its files were, and what came back in its place. */
export interface DeletedPackage {
  name: string;
  path: string;
  restored?: string;
}
