// File and shell mechanics of package installation: sources, clones, builds, links, and copies.
// Who may install what, and where, is decided by the caller.
import { createHash, type Hash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

const GIT_URL = /^(https?:\/\/|git@|git:\/\/|ssh:\/\/|file:\/\/).+|\.git$/;

/** A commit pin: exactly a full object name, so nothing shorter can be mistaken for one. */
const PIN = /@([0-9a-f]{40})$/;

/**
 * A git source is `<url>`, `<url>#<directory inside the repository>`, and either of those with `@<commit>`
 * on the end. The pin is what a marketplace install records: the index says what the latest version is, and
 * the install fixes the commit it actually took, so the package cannot change underneath it later.
 */
export function splitSource(source: string): { url: string; sub?: string; ref?: string } {
  const pin = PIN.exec(source);
  const rest = pin ? source.slice(0, -pin[0].length) : source;
  const ref = pin?.[1];
  const hash = rest.indexOf("#");
  if (hash < 0) return ref ? { url: rest, ref } : { url: rest };
  const sub = rest.slice(hash + 1);
  const url = rest.slice(0, hash);
  return { url, ...(sub ? { sub } : {}), ...(ref ? { ref } : {}) };
}

/** `<url>#<dir>@<commit>`, the form the marketplace hands to install. */
export function pinnedSource(url: string, sub: string | undefined, ref: string): string {
  return `${url}${sub ? `#${sub}` : ""}@${ref}`;
}

/** The clone directory name a source wants, pin and all: `splitSource` then `cloneSlug`, which every caller pairs. */
export function cloneSlugOf(source: string): string {
  const { url, ref } = splitSource(source);
  return cloneSlug(url, ref);
}

/**
 * Where a clone of this source lives under a userspace's store. The pin is part of the directory name, so
 * anything that looks for a clone -- taking one, repairing a link to one, pruning the ones nothing uses --
 * has to spell it the same way, and spelling it in one place is how they do.
 */
export function cloneDirFor(store: string, source: string): string {
  return resolve(store, "src", cloneSlugOf(source));
}

/**
 * A clone taken on another userspace's behalf: the system fence fetches a repository only it holds a key
 * for into `fetchDir` (under the system store, `fetch/<slug>`), and the host moves the result into `dir`,
 * the receiving userspace's own clone directory. The fetch directory is removed whether the fetch worked or
 * not, and it is never under the shared directory: that one every fence can read, and a private registry
 * copied there would be readable by everybody the key was meant to keep it from.
 */
export async function fetchInto(fetchDir: string, dir: string, fetch: () => Promise<void>): Promise<void> {
  rmSync(fetchDir, { recursive: true, force: true });
  try {
    await fetch();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    cpSync(fetchDir, dir, { recursive: true, verbatimSymlinks: true });
  } finally {
    rmSync(fetchDir, { recursive: true, force: true });
  }
}

/** Where the system fence fetches `source` for somebody else; see `fetchInto`. */
export function fetchDirFor(systemStore: string, source: string): string {
  return resolve(systemStore, "fetch", cloneSlugOf(source));
}

export function isGitSource(source: string): boolean {
  return GIT_URL.test(splitSource(source).url);
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The directory name a clone gets: the repository name, made safe for a path, and the commit when the source
 * is pinned. One registry repository holds many packages, so two installs of different commits must not share
 * a directory — the second would replace the first's code underneath the link that is already using it.
 */
export function cloneSlug(url: string, ref?: string): string {
  const name = basename(url).replace(/\.git$/, "").replace(/[^a-z0-9._-]/gi, "-");
  return ref ? `${name}-${ref.slice(0, 12)}` : name;
}

/**
 * Without a pin, the tip of the default branch. With one, that exact commit and nothing else: fetching the
 * object directly keeps it to one shallow round trip, which a full clone followed by a checkout would not.
 */
export function cloneCommand(url: string, dir: string, ref?: string): string {
  if (!ref) return `git clone --depth 1 ${shellQuote(url)} ${shellQuote(dir)}`;
  const at = `git -C ${shellQuote(dir)}`;
  return [
    `git init --quiet ${shellQuote(dir)}`,
    `${at} remote add origin ${shellQuote(url)}`,
    `${at} fetch --quiet --depth 1 origin ${shellQuote(ref)}`,
    `${at} checkout --quiet --detach FETCH_HEAD`,
  ].join(" && ");
}

/**
 * A mirror for indexing, not for installing: the index is built from manifests alone, so only those are
 * fetched. A blobless fetch with a sparse checkout brings down about 280 KB of this registry instead of
 * 4.5 MB, and the difference is entirely files no index ever reads.
 */
export function mirrorCommand(url: string, dir: string): string {
  const at = `git -C ${shellQuote(dir)}`;
  return [
    `rm -rf ${shellQuote(dir)}`,
    `git init --quiet ${shellQuote(dir)}`,
    `${at} remote add origin ${shellQuote(url)}`,
    `${at} config core.sparseCheckout true`,
    `${at} sparse-checkout set --no-cone '/*/package.json' '/*/*/package.json'`,
    `${at} fetch --quiet --depth 1 --filter=blob:none origin HEAD`,
    `${at} checkout --quiet --detach FETCH_HEAD`,
  ].join(" && ");
}

/**
 * The commit a clone is sitting on, or undefined when there is no clone. A detached checkout writes the
 * object name straight into HEAD, so this costs a file read rather than a subprocess.
 */
export function headOf(dir: string): string | undefined {
  try {
    const head = readFileSync(resolve(dir, ".git", "HEAD"), "utf8").trim();
    return /^[0-9a-f]{40}$/.test(head) ? head : undefined;
  } catch {
    return undefined;
  }
}

/** The command that makes a package runnable, or undefined when nothing needs to run. */
export function buildCommand(m: { scripts?: Record<string, string>; dependencies?: Record<string, string> }): string | undefined {
  if (m.scripts?.build) return "npm install --no-audit --no-fund && npm run build";
  if (Object.keys(m.dependencies ?? {}).length > 0) return "npm install --omit=dev --no-audit --no-fund";
  return undefined;
}

/** True when `target` is strictly inside `base` (not equal to it, and not reached through `..`). */
export function isInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Replaces `link` with a symlink to `target`. Links to targets under `root` are relative, so a moved data directory keeps working. */
export function linkDir(link: string, target: string, root: string): void {
  mkdirSync(dirname(link), { recursive: true });
  if (isLink(link)) rmSync(link);
  const inside = !relative(root, target).startsWith("..");
  symlinkSync(inside ? relative(dirname(link), target) : target, link, "dir");
}

export function removeLink(link: string): void {
  if (existsSync(link) || isLink(link)) rmSync(link, { recursive: true, force: true });
}

/**
 * Removes every entry of a directory whose name is not in `keep`. A directory that is not there is already
 * in that state, so there is nothing to do and nothing to report: the caller prunes what an install left
 * behind, and an installation that has never cloned anything has no `src` directory at all.
 */
export function keepOnly(base: string, keep: ReadonlySet<string>): void {
  if (!existsSync(base)) return;
  for (const entry of readdirSync(base)) if (!keep.has(entry)) rmSync(resolve(base, entry), { recursive: true, force: true });
}

export function hasPackageJson(dir: string): boolean {
  return existsSync(resolve(dir, "package.json"));
}

/** Copies a package directory (following the top-level link) and gives the copy a new name in its package.json. */
export function copyPackageAs(from: string, to: string, name: string): void {
  cpSync(realpathSync(from), to, { recursive: true, verbatimSymlinks: true });
  const file = resolve(to, "package.json");
  const manifest = JSON.parse(readFileSync(file, "utf8")) as { name: string };
  manifest.name = name;
  writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
}

export interface ForkSpec {
  /** The installed package's root (a store link is fine; it is followed). */
  from: string;
  /** The fork's directory. Must not exist. */
  to: string;
  name: string;
  version: string;
  origin: { name: string; version: string };
  /** The userspace root: links into it are relative, so a moved data directory keeps working. */
  root: string;
}

export interface ForkResult {
  manifest: ForkManifest;
  /** Dependencies satisfied with a link into the fork's node_modules instead of an npm install. */
  linked: string[];
}

/** The parts of a package.json a fork rewrites. Everything else is copied as it is. */
export interface ForkManifest {
  name: string;
  version: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  thetis: Record<string, unknown> & { forkedFrom?: { name: string; version: string } };
}

/**
 * The fork of `name` that a userspace already holds, if it holds one. This is the fork relation read
 * backwards, and it has to be read backwards because only one end of it is written down: a fork names its
 * origin in its own manifest, so "does this package displace something here?" is a question its manifest
 * answers, while "is something here already standing in for this package?" is not a question the incoming
 * package can answer at all. The only place that knows is what the userspace already holds.
 *
 * It takes records rather than directories on purpose. The question is asked before anything is fetched,
 * built or linked -- an admin installing a gateway for everyone has to know which people to leave alone
 * before the first clone -- and a record is what the kernel has at that point.
 */
export function forkOf(installed: { name: string; forkedFrom?: { name: string } }[], name: string): string | undefined {
  return installed.find((r) => r.name !== name && r.forkedFrom?.name === name)?.name;
}

/** The version a fork gets: `<origin>-fork.N`, where N follows the fork that already carries this name. */
export function forkVersion(origin: string, current?: string): string {
  const m = current ? /-fork\.(\d+)$/.exec(current) : null;
  const n = m && current?.startsWith(`${origin}-fork.`) ? Number(m[1]) + 1 : 1;
  return `${origin}-fork.${n}`;
}

/** Where `dep` resolves from `dir`, the way Node walks up through node_modules. Undefined when it does not. */
export function findDependency(dir: string, dep: string): string | undefined {
  for (let d = dir; ; d = dirname(d)) {
    const candidate = resolve(d, "node_modules", dep);
    if (hasPackageJson(candidate)) return realpathSync(candidate);
    if (dirname(d) === d) return undefined;
  }
}

/**
 * Copies a package (without its node_modules) and rewrites the copy's package.json for a fork: new name and
 * version, no scripts and no devDependencies (a shipped TypeScript package cannot rebuild inside a fence,
 * so the fork runs the copied dist), `thetis.forkedFrom` set. A dependency the origin already resolves is
 * linked into the fork's node_modules and dropped from `dependencies`: a workspace package such as
 * `@thetis/marketplace` is on no registry, so an npm install could never satisfy it.
 */
export function forkPackage(spec: ForkSpec): ForkResult {
  if (existsSync(spec.to)) throw new Error(`target exists: ${spec.to}`);
  const from = realpathSync(spec.from);
  const skip = resolve(from, "node_modules");
  cpSync(from, spec.to, { recursive: true, verbatimSymlinks: true, filter: (src) => resolve(src) !== skip });
  const file = resolve(spec.to, "package.json");
  const manifest = JSON.parse(readFileSync(file, "utf8")) as ForkManifest;
  manifest.name = spec.name;
  manifest.version = spec.version;
  delete manifest.scripts;
  delete manifest.devDependencies;
  const linked: string[] = [];
  const remaining: Record<string, string> = {};
  for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
    const found = findDependency(from, dep);
    if (found) {
      linkDir(resolve(spec.to, "node_modules", dep), found, spec.root);
      linked.push(dep);
    } else remaining[dep] = range;
  }
  if (Object.keys(remaining).length > 0) manifest.dependencies = remaining;
  else delete manifest.dependencies;
  manifest.thetis = { ...manifest.thetis, forkedFrom: { ...spec.origin } };
  writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  return { manifest, linked };
}

/**
 * The packages sitting directly under a directory: one entry per subdirectory whose manifest `read` accepts.
 * The walk, the missing-package.json guard and the swallowed error are mechanism; what counts as a readable
 * manifest is the caller's, which is why `read` is handed in rather than assumed. A directory that does not
 * exist has no packages in it, which is the same answer as an empty one and saves every caller a guard.
 */
export function packagesIn<T extends { name: string }>(base: string, read: (dir: string) => T): { dir: string; manifest: T }[] {
  if (!existsSync(base)) return [];
  const out: { dir: string; manifest: T }[] = [];
  for (const entry of readdirSync(base)) {
    const dir = resolve(base, entry);
    if (!hasPackageJson(dir)) continue;
    try {
      out.push({ dir, manifest: read(dir) });
    } catch {
      continue;
    }
  }
  return out;
}

/** Directories a package digest never looks at: what a package installs into, and what its own history is. */
const DIGEST_SKIP = new Set(["node_modules", ".git"]);

/** The fields `forkPackage` rewrites. Two packages that differ only in these are the same package under two names. */
const FORK_FIELDS = ["name", "version", "scripts", "dependencies", "devDependencies"];

/**
 * The package.json a digest sees: the copy with everything a fork rewrites taken out. A fork gets its own
 * name and version, loses `scripts` and `devDependencies` (it cannot rebuild inside a fence), and has the
 * dependencies it could link dropped in favour of links under its own `node_modules`. Comparing any of
 * those would say "different" about every fork ever made, including one that changed nothing at all, which
 * is the one case this exists to catch.
 */
function forkNeutralManifest(file: string): string {
  const manifest = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> & { thetis?: Record<string, unknown> };
  for (const field of FORK_FIELDS) delete manifest[field];
  if (manifest.thetis && typeof manifest.thetis === "object") {
    const { forkedFrom, ...rest } = manifest.thetis;
    manifest.thetis = rest;
  }
  return JSON.stringify(manifest);
}

function digestInto(dir: string, base: string, hash: Hash): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (DIGEST_SKIP.has(entry.name)) continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      digestInto(path, base, hash);
      continue;
    }
    // The path goes in as well as the contents: two trees holding the same bytes under different names are
    // not the same package, and hashing contents alone would say they were.
    hash.update(relative(base, path));
    hash.update("\0");
    if (entry.isSymbolicLink()) hash.update(`L${readlinkSync(path)}`);
    else if (path === resolve(base, "package.json")) hash.update(`F${forkNeutralManifest(path)}`);
    else {
      hash.update("F");
      hash.update(readFileSync(path));
    }
    hash.update("\0");
  }
}

/**
 * A content digest of a package directory, blind to the name and version a fork carries. `node_modules` is
 * left out because it is what an install put there rather than what the author wrote, and `.git` because a
 * clone's history is not the package. Reading the whole tree costs a few milliseconds for the largest
 * package there is, so a caller computes it when a person is about to be told something, not on every list.
 */
export function packageDigest(dir: string): string {
  const hash = createHash("sha256");
  digestInto(resolve(dir), resolve(dir), hash);
  return hash.digest("hex");
}

/**
 * True when two package directories hold the same package under two names: the same files, byte for byte,
 * with only the fields a fork rewrites allowed to differ. This is what turns "a fork" into "a fork that is
 * carrying no change at all", which is a thing a person wants to be told, because it means they are holding
 * a copy of the shipped package that will never see another fix.
 */
export function samePackage(a: string, b: string): boolean {
  try {
    return packageDigest(a) === packageDigest(b);
  } catch {
    return false;
  }
}
