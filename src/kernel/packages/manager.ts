import { existsSync, rmSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { HOST_TYPE, STORAGE_TYPE, SYSTEM_SCOPE, SYSTEM_USER, type DeletedPackage, type EveryoneBy, type Fences, type InstalledRecord, type Manifest, type PackageInfo, type PackageSource, type UserRecord, type Userspace } from "../../contracts/index.js";
import { assert, CodedError, errorMessage } from "../../lib/error.js";
import { ExecResultSchema } from "../../contracts/schemas/fence.js";
import { repoGrantFor } from "../../lib/ssh.js";
import { parseSchema } from "../../lib/validation.js";
import { buildCommand, cloneCommand, cloneDirFor, cloneSlugOf, copyPackageAs, fetchDirFor, fetchInto, forkOf, hasPackageJson, headOf, isGitSource, isInside, keepOnly, linkDir, packagesIn, removeLink, samePackage, splitSource } from "../../lib/pkg-fs.js";
import type { KernelConfig } from "../config.js";
import { readManifest, scopeOf, toInfo } from "./manifest.js";
import type { PackageRegistry } from "./registry.js";

/** Peers the platform itself satisfies. They are types for package authors, never installed into a userspace. */
const PLATFORM_PEERS = new Set(["@thetis/runtime"]);
const BUILD_TIMEOUT_MS = 300_000;

export interface PackageListener {
  installed?(us: Userspace, pkg: PackageInfo): Promise<void>;
  uninstalled?(us: Userspace, pkg: PackageInfo): Promise<void>;
  /** The package's files are gone: what was kept for it in the userspace goes too. */
  deleted?(us: Userspace, name: string): Promise<void>;
  /** A copy under the system scope exists; what was set for the original follows it. */
  promoted?(from: string, to: string): Promise<void>;
}

/**
 * Decides what may be installed where, and records it. Clones and builds run inside the fence of the
 * userspace that receives the package -- except a clone of a repository the installation holds a key for,
 * which the system fence takes -- and the link into its store and the registry row are the kernel's.
 */
export class PackageManager {
  private readonly listeners: PackageListener[] = [];

  constructor(
    private readonly config: KernelConfig,
    private readonly registry: PackageRegistry,
    private readonly fences: Fences,
    /** The system userspace, whose grants are the installation's repository keys. */
    private readonly system?: () => Userspace,
  ) {}

  /** Observers of installs, uninstalls, deletions and promotions: the service supervisor, and the host's store and config hooks. */
  observe(listener: PackageListener): void {
    this.listeners.push(listener);
  }

  private async each(fn: (l: PackageListener) => Promise<void> | undefined): Promise<void> {
    for (const l of this.listeners) await fn(l);
  }

  /**
   * The manifest of a package as this userspace sees it: the store link when it is there, else the shipped
   * or promoted directory. A fork's origin is uninstalled by the fork, so its configuration chain is read this way.
   */
  manifestOf(us: Userspace, name: string): Manifest | undefined {
    const link = this.linkPath(us, name);
    const dir = hasPackageJson(link) ? link : (this.systemPackageDir(name) ?? this.displacedDir(us, name));
    try {
      return dir ? readManifest(dir) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Where a package a fork displaced still lives: its files stay where they were installed from. */
  private displacedDir(us: Userspace, name: string): string | undefined {
    const src = this.registry.installedIn(us.id).find((r) => r.replaced === name)?.replacedSource;
    if (!src || src.kind === "system") return undefined;
    return src.kind === "local" ? resolve(us.home, src.ref) : this.subdir(cloneDirFor(us.store, src.ref), splitSource(src.ref).sub);
  }

  /** Installed packages of a userspace, with their live manifests, in install order. */
  installed(us: Userspace): PackageInfo[] {
    const out: PackageInfo[] = [];
    const everyone = this.everyoneMap();
    // The record knows where the copy came from; the manifest does not. Carrying it lets a reader see the
    // pin an installation is following without asking the registry a second question.
    const mark = (info: PackageInfo, rec: InstalledRecord) => ({
      ...info,
      ...(everyone.has(info.name) ? { everyone: true, everyoneBy: everyone.get(info.name) } : {}),
      ...(rec.replaced ? { replaced: rec.replaced } : {}),
      ...(rec.source ? { source: rec.source } : {}),
    });
    for (const rec of this.registry.installedIn(us.id)) {
      const root = this.linkPath(us, rec.name);
      if (!hasPackageJson(root)) {
        const relinked = this.relink(us, rec);
        if (relinked) out.push(mark(relinked, rec));
        else console.error(`[packages] ${rec.name} is recorded for ${us.id} but its files are missing`);
        continue;
      }
      try {
        out.push(mark(toInfo(readManifest(root), root), rec));
      } catch (err) {
        console.error(`[packages] skipping ${rec.name}: ${errorMessage(err)}`);
      }
    }
    return out;
  }

  /**
   * Installed packages as a caller outside the kernel sees them: each one also carries the version the
   * userspace's open fence read when it opened, when that is known. The two differing is the whole point:
   * the files on disk changed under a running fence, and only a reload puts them into service.
   */
  listFor(us: Userspace): PackageInfo[] {
    const loaded = (this.fences.loadedVersions?.() ?? {})[us.id] ?? {};
    return this.installed(us).map((p) => this.withFork(us, loaded[p.name] ? { ...p, loadedVersion: loaded[p.name] } : p));
  }

  /**
   * A fork, measured against the package it was copied from as that package stands now. The manifest
   * records only what the origin was at the time of the copy, and a copy that says only that is a dead end:
   * the origin goes on being fixed and nobody holding the fork is ever told. So the origin is looked up
   * where it actually lives -- displaced by this very fork, or shipped, or promoted -- and its version and
   * its bytes are compared with the copy's.
   *
   * This is only done here, on the way out to a person, and not in `installed`, which the kernel's own
   * install, restore and seed paths call. Reading the whole of two package trees costs milliseconds, which
   * is nothing to pay once for a listing somebody is about to read and too much to pay on every internal
   * question about what is installed.
   *
   * `everyone` is the fork's other half of the news. An admin who makes a package the default for everyone
   * cannot make it this person's -- their fork is in the way, and the sweep leaves it there by design -- so
   * the only place that decision can reach them is here, on the row of the copy standing in for it.
   */
  private withFork(us: Userspace, info: PackageInfo): PackageInfo {
    const from = info.forkedFrom;
    if (!from) return info;
    const dir = this.systemPackageDir(from.name) ?? this.displacedDir(us, from.name);
    const shipped = this.manifestOf(us, from.name)?.version;
    return { ...info, fork: { ...from, ...(shipped ? { shipped } : {}), ...(dir && samePackage(info.root, dir) ? { identical: true } : {}), ...(this.forEveryone().includes(from.name) ? { everyone: true } : {}) } };
  }

  /**
   * Links the system packages into a fresh userspace: for a person, the `"*"` list, every promoted
   * package, and every package an admin marked for everyone; the userspace's own list always. The
   * system userspace is not a person. Idempotent.
   *
   * A package somebody here has forked is skipped, for the reasons in `displace`. This is the one path
   * that installs a system package without going through `install`, so the rule has to be stated twice or
   * a seed would quietly undo what the fork rule decided -- and a seed is not a person asking for
   * anything, so there is nobody here to refuse to.
   */
  seedSystem(us: Userspace): void {
    const everyone = us.id === SYSTEM_USER ? [] : this.forEveryone();
    const names = [...everyone, ...(this.config.systemPackages[us.id] ?? [])];
    for (const name of new Set(names)) {
      if (!this.registry.installOf(name, us.id) && !forkOf(this.registry.installedIn(us.id), name)) this.installSystem(us, name);
    }
  }

  /** The packages every person gets: the `"*"` list, every promoted package, and every package marked for everyone. */
  forEveryone(): string[] {
    return [...this.everyoneMap().keys()];
  }

  /**
   * The same set, each name with why it is everyone's. The configuration outranks a promotion, which
   * outranks an admin's mark, because that is the order in which they can be undone from a page: a mark
   * is taken back by `markEveryone`, a promotion by removing the promoted copy, the `"*"` list only by
   * editing the configuration -- and a page offering to undo what it cannot is the trap this avoids.
   */
  private everyoneMap(): Map<string, EveryoneBy> {
    const by = new Map<string, EveryoneBy>();
    for (const name of this.registry.everyone()) by.set(name, "marked");
    for (const name of this.promoted()) by.set(name, "promoted");
    for (const name of this.config.systemPackages["*"] ?? []) by.set(name, "config");
    return by;
  }

  /**
   * Every system package on disk, shipped first and then promoted, whether or not anyone has it: what a
   * person may install by name. The installation put these here, so linking one into one's own workspace
   * is open to everyone; the marketplace lists them beside what the registries offer.
   */
  catalog(): PackageInfo[] {
    const everyone = this.everyoneMap();
    const out = new Map<string, PackageInfo>();
    for (const base of [this.config.systemPackagesDir, this.config.promotedPackagesDir]) {
      for (const { dir, manifest } of packagesIn(base, readManifest)) {
        if (out.has(manifest.name)) continue;
        const by = everyone.get(manifest.name);
        out.set(manifest.name, { ...toInfo(manifest, dir), source: { kind: "system", ref: dir }, ...(by ? { everyone: true, everyoneBy: by } : {}) });
      }
    }
    return [...out.values()];
  }

  /** Marks a shipped system package as the default for everyone. New people are seeded with it. */
  markEveryone(name: string, on: boolean): void {
    assert(scopeOf(name) === SYSTEM_SCOPE && this.systemPackageDir(name), `not a system package: ${name}`, "invalid");
    this.registry.setEveryone(name, on);
  }

  /** The names of the promoted packages: everything in the promoted directory with a valid manifest. */
  promoted(): string[] {
    return packagesIn(this.config.promotedPackagesDir, readManifest).map((p) => p.manifest.name);
  }

  installSystem(us: Userspace, name: string, replaced?: { replaced: string; replacedSource: PackageSource }): PackageInfo {
    assert(scopeOf(name) === SYSTEM_SCOPE, `not a system package: ${name}`);
    const dir = this.systemPackageDir(name);
    assert(dir, `unknown system package: ${name}`);
    const manifest = readManifest(dir);
    this.link(us, name, dir);
    const source: PackageSource = { kind: "system", ref: dir };
    this.registry.record(name, us.id, { version: manifest.version, type: manifest.thetis.type, source, ...replaced }, manifest.thetis.forkedFrom);
    // The answer says where the copy came from, as the listing does: a caller drawing the row it just installed needs the same facts.
    return { ...toInfo(manifest, this.linkPath(us, name)), source };
  }

  /**
   * Installs from a git URL, a path inside the userspace, or a @thetis/* name. A name is a system package
   * -- shipped or promoted, already on disk and already built -- and anyone may link one into their own
   * workspace: the installation vouched for it by shipping it, and the link runs in the person's fence as
   * them. A @thetis-scoped *source* is different: it is code from elsewhere claiming the system scope, and
   * `checkNamespace` leaves that to admins. Every other scope is a name: anyone installs any source into
   * their own workspace, and the registry keeps that workspace's entry apart from everybody else's, so
   * whose namespace a package sits in decides nothing. A fork whose origin is installed here replaces it in one
   * operation: the origin's service stops and its link goes before the fork's link and service come, so
   * tool names and sockets never clash.
   */
  async install(us: Userspace, actor: UserRecord, source: string): Promise<PackageInfo> {
    if (scopeOf(source) === SYSTEM_SCOPE && !source.includes("/", SYSTEM_SCOPE.length + 1)) {
      const dir = this.systemPackageDir(source);
      assert(dir, `${source} is not a system package here: nothing shipped or promoted has that name`, "not-found");
      const replaced = await this.displace(us, installable(readManifest(dir)));
      const info = this.installSystem(us, source, replaced);
      await this.each((l) => l.installed?.(us, info));
      return info;
    }
    const kind: PackageSource["kind"] = isGitSource(source) ? "git" : "local";
    const dir = kind === "git" ? await this.clone(us, source) : this.localDir(us, source);
    const manifest = installable(readManifest(dir));
    this.checkNamespace(manifest, actor);
    this.checkPeers(manifest, us);
    await this.build(us, dir, manifest);
    const replaced = await this.displace(us, manifest);
    this.link(us, manifest.name, dir);
    const from: PackageSource = { kind, ref: source };
    this.registry.record(manifest.name, us.id, { version: manifest.version, type: manifest.thetis.type, source: from, ...replaced }, manifest.thetis.forkedFrom);
    const info = { ...toInfo(manifest, this.linkPath(us, manifest.name)), source: from, ...(replaced ? { replaced: replaced.replaced } : {}) };
    if (kind === "git") this.pruneClones(us);
    await this.each((l) => l.installed?.(us, info));
    return info;
  }

  /** Removes the link and the record. When the package had displaced its origin, the origin comes back, service and all. */
  async uninstall(us: Userspace, name: string): Promise<PackageInfo | undefined> {
    const rec = this.registry.installOf(name, us.id);
    const pkg = this.installed(us).find((p) => p.name === name);
    if (pkg) await this.each((l) => l.uninstalled?.(us, pkg));
    removeLink(this.linkPath(us, name));
    this.registry.unlink(name, us.id);
    return rec?.replaced ? this.restore(us, rec.replaced, rec.replacedSource) : undefined;
  }

  /**
   * Undoes a fork: the userspace goes back to the package the fork was copied from. The inverse of a fork,
   * and the thing whose absence made a fork a one-way door -- an `uninstall` puts the origin back only when
   * the registry happens to have recorded what this fork displaced, and a fork installed into a userspace
   * the origin was not in has no such record and takes the person's only gateway with it.
   *
   * The ordering is the whole of the safety, because the package a person is most likely to fork is the web
   * gateway, and they are looking at the fork through it:
   *
   *   1. Find where the origin lives, before anything is changed. No origin on disk, no un-fork: a person
   *      is told to keep the fork rather than being left with neither.
   *   2. Swap. The fork's service stops and its link goes, then the origin's link and service come. Both
   *      gateways bind the same socket, so they cannot overlap; the gap is the length of a stop and a
   *      start, and the door answers 503 for that moment rather than routing to something that is gone.
   *   3. Delete the files last, and only if asked. A failure anywhere above leaves the fork's source where
   *      it was, so `install` from the same path puts the person back exactly where they started.
   *
   * `uninstall` already restores a recorded `replaced`, so its answer is taken when it has one and the
   * origin is put back by name when it does not; that way the origin's service is started once, not twice.
   */
  async unfork(us: Userspace, name: string, deleteFiles = false): Promise<PackageInfo> {
    const rec = this.registry.installOf(name, us.id);
    const origin = this.installed(us).find((p) => p.name === name)?.forkedFrom?.name;
    assert(rec && origin, `${name} is not a fork installed in ${us.id}`, "invalid");
    assert(this.manifestOf(us, origin), `${origin} is not here to go back to; keep ${name}, or install ${origin} from its source first`, "not-found");
    const files = deleteFiles && rec.source.kind === "local" ? resolve(us.home, rec.source.ref) : undefined;
    const back = (await this.uninstall(us, name)) ?? (await this.restore(us, origin));
    assert(back, `${origin} did not come back; install it, or install ${name} again from ${rec.source.ref}`, "not-found");
    if (files && isInside(us.home, files)) {
      rmSync(files, { recursive: true, force: true });
      await this.each((l) => l.deleted?.(us, name));
    }
    return back;
  }

  /** Uninstalls a package and deletes its files. Only a copy that lives under this userspace's home goes: the files are the person's by where they are, not by what the package is called. */
  async delete(us: Userspace, name: string): Promise<DeletedPackage> {
    const rec = this.registry.installOf(name, us.id);
    assert(rec, `${name} is not installed in ${us.id}`, "not-found");
    const dir = rec.source.kind === "local" ? resolve(us.home, rec.source.ref) : undefined;
    assert(dir && isInside(us.home, dir), `${name} does not live under the home directory; uninstall it instead`, "unauthorized");
    const restored = await this.uninstall(us, name);
    rmSync(dir, { recursive: true, force: true });
    await this.each((l) => l.deleted?.(us, name));
    return { name, path: dir, ...(restored ? { restored: restored.name } : {}) };
  }

  /**
   * The fork rule, in both directions. Forwards: a manifest that names an origin installed here has that
   * origin stopped and unlinked first, so the fork takes its place in one operation. Backwards: a package
   * whose fork is already installed here is refused, and the refusal names the fork.
   *
   * The two directions are deliberately not symmetrical. A displaced origin is recoverable: it is shipped
   * or promoted, its files are the kernel's own, `restore` puts it back by name and `unfork` exists to ask
   * for exactly that. A displaced fork would be the person's own work, and nothing here could put it back
   * -- the registry keeps one document per package name with the userspaces it is in, so recording that
   * `@thetis/gateway-web` had displaced alice's fork would claim it in every userspace holding the shipped
   * gateway and restore the wrong thing at the next uninstall anywhere. The second install therefore does
   * not happen. Leaving both installed, which is what happened before this, is the worst of the three: two
   * gateways bind the same `run/web.sock` and the second one to start silently takes the socket from the
   * first, so the person's fork stops answering their own browser and nothing says why.
   *
   * A refusal is also the only answer anybody hears. The person is told before their gateway goes out of
   * service; an admin is told which people were left alone rather than believing a package is everywhere
   * when it is not. `installEverywhere` asks `forkOf` the same question before it calls, so a sweep across
   * the fleet names those people and carries on instead of stopping on one person's private decision.
   *
   * In the git and local paths the refusal lands after the build, because the displacement itself has to:
   * a fork that fails to build must not have stopped the origin's service first, and both halves of the
   * rule belong in one place. Nothing has been removed or linked by then, so what a clashing install costs
   * is the build's time and nothing else.
   */
  private async displace(us: Userspace, m: Manifest): Promise<{ replaced: string; replacedSource: PackageSource } | undefined> {
    const fork = forkOf(this.registry.installedIn(us.id), m.name);
    assert(!fork, `${us.id} holds ${fork}, a fork of ${m.name}: un-fork ${fork} first, or leave it in place`, "fork");
    const origin = m.thetis.forkedFrom?.name;
    const rec = origin && origin !== m.name ? this.registry.installOf(origin, us.id) : undefined;
    if (!rec) return undefined;
    await this.uninstall(us, rec.name);
    return { replaced: rec.name, replacedSource: rec.source };
  }

  /** Puts a displaced origin back: a system package by name, anything else from where it was installed from. */
  private async restore(us: Userspace, name: string, source?: PackageSource): Promise<PackageInfo | undefined> {
    const own = source && source.kind !== "system" ? { name, source } : undefined;
    const info = own ? this.relink(us, own) : this.systemPackageDir(name) ? this.installSystem(us, name) : undefined;
    if (!info) return undefined;
    if (own) this.registry.record(name, us.id, { version: info.version, type: info.type, source: own.source });
    await this.each((l) => l.installed?.(us, info));
    return info;
  }

  /** Where a @thetis/* package lives: the shipped directory first, then the promoted one. */
  systemPackageDir(name: string): string | undefined {
    for (const base of [this.config.systemPackagesDir, this.config.promotedPackagesDir]) {
      const hit = packagesIn(base, readManifest).find((p) => p.manifest.name === name);
      if (hit) return hit.dir;
    }
    return undefined;
  }

  /**
   * Makes a package this userspace holds the default for everyone: copies it into the promoted directory
   * under the @thetis scope, from where every new userspace is seeded with it. Returns the new name. The
   * caller links it into the existing userspaces and removes this userspace's original. Any copy that is
   * not the installation's own will do -- a package is promoted from where it is, whatever its scope says.
   * The configuration file is never written by the kernel.
   */
  async promote(us: Userspace, name: string): Promise<string> {
    const rec = this.registry.installOf(name, us.id);
    assert(rec && rec.source.kind !== "system", `${name} is not installed in ${us.id} from a source of its own`, "invalid");
    const base = name.slice(name.indexOf("/") + 1);
    const promoted = `${SYSTEM_SCOPE}/${base}`;
    const target = resolve(this.config.promotedPackagesDir, base);
    assert(!existsSync(target) && !this.systemPackageDir(promoted), `${promoted} already exists`, "invalid");
    copyPackageAs(this.linkPath(us, name), target, promoted);
    readManifest(target);
    await this.each((l) => l.promoted?.(name, promoted));
    return promoted;
  }

  /** The one namespace with a meaning: `@thetis` is resolved by name on disk, so a source claiming it is an admin's to install. */
  private checkNamespace(m: Manifest, actor: UserRecord): void {
    assert(scopeOf(m.name) !== SYSTEM_SCOPE || actor.role !== "user", `${m.name}: ${SYSTEM_SCOPE} is the installation's namespace; only an admin installs a source that claims it`, "unauthorized");
  }

  private checkPeers(m: Manifest, us: Userspace): void {
    const present = new Set(this.registry.installedIn(us.id).map((r) => r.name));
    for (const peer of Object.keys(m.peerDependencies ?? {})) {
      if (PLATFORM_PEERS.has(peer)) continue;
      assert(present.has(peer), `${m.name} requires ${peer}, which is not installed in this userspace`, "peer");
    }
  }

  private async clone(us: Userspace, source: string): Promise<string> {
    const { url, sub, ref } = splitSource(source);
    const dir = cloneDirFor(us.store, source);
    // A pinned clone is the same bytes whenever it is taken, and one registry holds many packages, so a
    // clone already sitting on that commit is reused rather than fetched again. Without a pin there is
    // nothing to compare and the tip may have moved, so it is always fetched.
    if (!ref || headOf(dir) !== ref) {
      rmSync(dir, { recursive: true, force: true });
      // A repository only the installation holds a key for is fetched by the system fence, which alone
      // holds it, and handed over as files: the person gets the package, never the use of the key.
      const sys = us.id === SYSTEM_USER ? undefined : this.system?.();
      if (sys && repoGrantFor(sys.ssh ?? [], url)) {
        const fetch = fetchDirFor(sys.store, source);
        await fetchInto(fetch, dir, () => this.exec(sys, cloneCommand(url, fetch, ref), sys.store));
      } else await this.exec(us, cloneCommand(url, dir, ref), us.store);
    }
    return this.subdir(dir, sub);
  }

  /**
   * Removes clones nothing is installed from. Updating pins a new commit and leaves the old clone behind,
   * and a clone is the whole repository, so without this an installation grows by one copy every update.
   */
  private pruneClones(us: Userspace): void {
    const sources = this.registry.installedIn(us.id).flatMap((r) => r.replacedSource ? [r.source, r.replacedSource] : [r.source]);
    const live = sources.filter((source) => source.kind === "git").map((source) => cloneSlugOf(source.ref));
    keepOnly(resolve(us.store, "src"), new Set(live));
  }

  /** The package directory inside a clone. It must stay inside the clone. */
  private subdir(dir: string, sub: string | undefined): string {
    if (!sub) return dir;
    const inner = resolve(dir, sub);
    assert(isInside(dir, inner), `package directory must be inside the repository: ${sub}`, "unauthorized");
    return inner;
  }

  private localDir(us: Userspace, source: string): string {
    const dir = isAbsolute(source) ? source : resolve(us.home, source);
    assert(isInside(us.root, dir), `package path must be inside the userspace: ${source}`, "unauthorized");
    assert(hasPackageJson(dir), `no package.json at ${source}`);
    return dir;
  }

  private async build(us: Userspace, dir: string, m: Manifest): Promise<void> {
    const cmd = buildCommand(m);
    if (cmd) await this.exec(us, cmd, dir);
    if (m.main) assert(existsSync(resolve(dir, m.main)), `${m.name}: main entry ${m.main} does not exist after build`);
  }

  private async exec(us: Userspace, cmd: string, cwd: string): Promise<void> {
    const r = parseSchema(ExecResultSchema, await this.fences.request(us, "exec", { cmd, cwd, timeoutMs: BUILD_TIMEOUT_MS }), "package build exec reply", "build");
    if (r.code !== 0) throw new CodedError(`command failed (${r.code}): ${cmd}\n${r.stderr || r.stdout}`.slice(0, 4000), "build");
  }

  /** Repairs a dead store link after the checkout or the data directory moved. */
  private relink(us: Userspace, rec: { name: string; source: PackageSource }): PackageInfo | undefined {
    if (rec.source.kind === "system") return this.systemPackageDir(rec.name) ? this.installSystem(us, rec.name) : undefined;
    // The pin is part of the clone's directory name, so repairing a link has to carry it or it looks for a
    // clone that was never made.
    const dir = rec.source.kind === "local" ? resolve(us.home, rec.source.ref) : this.subdir(cloneDirFor(us.store, rec.source.ref), splitSource(rec.source.ref).sub);
    if (!hasPackageJson(dir)) return undefined;
    this.link(us, rec.name, dir);
    return toInfo(readManifest(dir), this.linkPath(us, rec.name));
  }

  private link(us: Userspace, name: string, target: string): void {
    linkDir(this.linkPath(us, name), target, us.root);
  }

  private linkPath(us: Userspace, name: string): string {
    return resolve(us.store, "node_modules", name);
  }
}

/** A storage driver serves the service plane from the host; a fence has no use for it and must not hold one. */
function installable(m: Manifest): Manifest {
  assert(m.thetis.type !== STORAGE_TYPE, `${m.name} is a storage driver: it runs on the host and is chosen by storage.driver in thetis.config.json; it is not installed`, "invalid");
  assert(m.thetis.type !== HOST_TYPE, `${m.name} is a host package: the host loads it by name from the shipped or promoted packages and answers host.${m.thetis.host?.name ?? "<name>"}.<export>; it is not installed`, "invalid");
  return m;
}

