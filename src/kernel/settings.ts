import { SYSTEM_USER, type ConfigReport, type Userspace } from "../contracts/index.js";
import { changedPackages, checkValue, describe, forkChain, isSecretKey, mergedDecls, mergeDocs, resolveRefs, type ConfigLink, type EnvSource, type LayeredConfig } from "../lib/config.js";
import { assert } from "../lib/error.js";
import type { Journal } from "../lib/journal.js";
import type { UserspaceLayout } from "../lib/userspace-layout.js";
import type { PackageManager } from "./packages/manager.js";
import type { PackageRegistry } from "./packages/registry.js";

/** One change to a layer, and every installed package it reaches: the package itself and every fork of it. */
export interface ConfigChange {
  name: string;
  user?: string;
  affected: Affected[];
}

export interface Affected {
  user: string;
  package: string;
}

/** A package at one layer. No user is the system layer. */
export interface ConfigTarget {
  user?: string;
  name: string;
}

/** What a dispatch site needs: the configuration a package's code receives, and nothing about how it is kept. */
export type Settings = Pick<ConfigService, "effective">;

/**
 * Who may set what, and who is told. The layers themselves are mechanism in @thetis/lib; this decides that
 * a `scope: "system"` key is an admin's at the system layer only, journals every change without its value,
 * and works out which fences a change reaches so the host can restart their services.
 */
export class ConfigService {
  private readonly listeners: ((change: ConfigChange) => Promise<void>)[] = [];

  constructor(
    /** The file layer, always a copy: see `reload`. The constructor's caller passes the live object. */
    public filePackages: Record<string, Record<string, unknown>>,
    private readonly layers: LayeredConfig,
    private readonly env: EnvSource,
    private readonly packages: PackageManager,
    private readonly registry: PackageRegistry,
    private readonly userspaces: UserspaceLayout,
    private readonly journal: Journal,
  ) {}

  onChange(listener: (change: ConfigChange) => Promise<void>): void {
    this.listeners.push(listener);
  }

  /** What a package's code receives in `us`: every layer merged, secrets included, references resolved. */
  async effective(us: Userspace, name: string): Promise<Record<string, unknown>> {
    const docs = await this.layers.docs(this.chainIn(us, name), us.id === SYSTEM_USER ? undefined : us.id);
    return resolveRefs(mergeDocs(docs).values, this.env.snapshot()).value;
  }

  /** The state of every key, secrets redacted. */
  async show(target: ConfigTarget): Promise<ConfigReport> {
    const chain = this.chain(target);
    return describe(target.name, chain, await this.layers.docs(chain, target.user), this.env.snapshot(), target.user);
  }

  /** One report per package installed in that person's userspace, or installed anywhere at the system layer. */
  list(user?: string): Promise<ConfigReport[]> {
    const records = user ? this.registry.installedIn(user) : this.registry.all();
    return Promise.all(records.map((r) => this.show({ user, name: r.name })));
  }

  async set(target: ConfigTarget, key: string, value: unknown, actor: string, fromFence = false): Promise<ConfigReport> {
    const decls = mergedDecls(this.chain(target));
    checkValue(decls, key, value);
    assert(decls[key]?.scope !== "system" || (!target.user && !fromFence), `${key} is set for the whole system by an admin`, "unauthorized");
    const secret = isSecretKey(decls, key);
    await this.layers.write(target.user, target.name, key, value, secret);
    return this.done("config.set", target, key, actor, secret);
  }

  async unset(target: ConfigTarget, key: string, actor: string): Promise<ConfigReport> {
    const secret = isSecretKey(mergedDecls(this.chain(target)), key);
    await this.layers.remove(target.user, target.name, key);
    return this.done("config.unset", target, key, actor, secret);
  }

  /**
   * Takes a new file layer: says which packages it changed, tells the listeners, and names the services that
   * restarted.
   *
   * `previous` exists because the layer is held by reference on purpose: `config.packages` is the live file
   * layer, and writing a key straight into it is how the kernel and its tests set one without a reload. So
   * `config.reload` cannot be answered by diffing what this service holds -- `applyInPlace` has already
   * rewritten that very object, and the diff would be against itself. It was, and the result was that no
   * package ever counted as changed, no service ever restarted on a configuration change, and the command
   * line said "nothing changed in the file" in the same breath as naming the keys it had just applied.
   * The caller snapshots the layer before rewriting it and passes the snapshot here.
   */
  async reload(next: Record<string, Record<string, unknown>>, previous: Record<string, Record<string, unknown>> = this.filePackages): Promise<{ changed: string[]; restarted: Affected[] }> {
    const changed = changedPackages(previous, next);
    this.filePackages = next;
    this.layers.invalidate();
    const restarted: Affected[] = [];
    for (const name of changed) {
      for (const a of await this.changed({ name })) if (this.manifest(a.user, a.package)?.thetis.service) restarted.push(a);
    }
    return { changed, restarted };
  }

  forgetPackage(user: string, name: string): Promise<void> {
    return this.layers.forgetPackage(user, name);
  }

  forgetUser(user: string): Promise<void> {
    return this.layers.forgetUser(user);
  }

  copySystem(from: string, to: string): Promise<void> {
    return this.layers.copySystem(from, to);
  }

  /** The row never holds the value; a secret is named as one. Then the listeners, then the state as it is now. */
  private async done(kind: string, target: ConfigTarget, key: string, actor: string, secret: boolean): Promise<ConfigReport> {
    this.journal.append({ kind, actor, target: target.user ?? SYSTEM_USER, data: { package: target.name, key, layer: target.user ? "user" : "system", secret } });
    await this.changed(target);
    return this.show(target);
  }

  /** Every installed package whose chain includes the changed one, in the userspaces the change reaches. */
  private async changed(target: ConfigTarget): Promise<Affected[]> {
    const affected: Affected[] = [];
    for (const rec of this.registry.all()) {
      for (const user of Object.keys(rec.installs).filter((u) => !target.user || u === target.user)) {
        if (this.chainIn(this.userspaces.pathFor(user), rec.name).some((l) => l.name === target.name)) affected.push({ user, package: rec.name });
      }
    }
    for (const listener of this.listeners) await listener({ name: target.name, user: target.user, affected });
    return affected;
  }

  /** The chain as seen from the target's userspace; for the system layer, from any userspace that has the package. */
  private chain(target: ConfigTarget): ConfigLink[] {
    // Any workspace that has the package, or that holds the fork standing in for it.
    const holder = this.registry.holders(target.name)[0] ?? this.registry.all().flatMap((r) => Object.entries(r.installs)).find(([, i]) => i.replaced === target.name)?.[0];
    const us = this.userspaces.pathFor(target.user ?? holder ?? SYSTEM_USER);
    assert(this.manifest(us.id, target.name), `${target.name} is not installed${target.user ? ` for ${target.user}` : ""}`, "not-found");
    return this.chainIn(us, target.name);
  }

  private chainIn(us: Userspace, name: string): ConfigLink[] {
    return forkChain(name, (n) => this.packages.manifestOf(us, n)?.thetis);
  }

  private manifest(user: string, name: string) {
    return this.packages.manifestOf(this.userspaces.pathFor(user), name);
  }
}
