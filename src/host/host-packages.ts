// Host packages are loaded here, on the host, the way the storage driver is: found by name among the shipped
// and the promoted packages, never installed into a fence. The kernel holds `HostExtensions` only and
// dispatches `host.<name>.<export>` to `call` after checking who is calling; what the package does with the
// host is its own, over the `HostEnv` the composition root built.
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { HOST_TYPE, type HostEnv, type HostMethod } from "../contracts/index.js";
import type { HostExtensions, KernelConfig } from "../kernel/index.js";
import { readManifest } from "../kernel/packages/manifest.js";
import { CodedError } from "../lib/error.js";
import { findPackage } from "./store.js";

export class HostPackages implements HostExtensions {
  /** Where each name was found. A miss scans again, so a package promoted after boot is found on its first call. */
  private readonly dirs = new Map<string, string>();

  constructor(
    private readonly config: KernelConfig,
    private readonly env: HostEnv,
    private readonly log: (line: string) => void,
  ) {}

  /**
   * Runs one export of the package named. The entry is imported under its modification time, as the
   * userspace agent imports a package's entry, so an edited file is live on the next call and an unchanged
   * one is the module already loaded. Whatever the method throws goes back to the caller as it is.
   */
  async call(name: string, method: string, args: Record<string, unknown>): Promise<unknown> {
    const dir = this.locate(name);
    const manifest = readManifest(dir);
    const main = resolve(dir, manifest.main ?? "index.js");
    const { mtimeMs } = statSync(main);
    const mod = (await import(`${pathToFileURL(main).href}?v=${mtimeMs}`)) as Record<string, unknown>;
    const fn = mod[method];
    if (typeof fn !== "function") throw new CodedError(`the host package ${manifest.name} (${name}) does not export a method named ${method}`, "not-found");
    return (fn as HostMethod)(args, this.env);
  }

  /**
   * The exports the package lets a person call about themselves (`thetis.host.self`), read from its manifest
   * on every call as the entry is, so an edited declaration is live on the next call. A package that is not
   * there is not-found, as `call` would be.
   */
  selfExports(name: string): string[] {
    return readManifest(this.locate(name)).thetis?.host?.self ?? [];
  }

  private locate(name: string): string {
    const known = this.dirs.get(name);
    if (known && existsSync(resolve(known, "package.json"))) return known;
    const bases = [this.config.systemPackagesDir, this.config.promotedPackagesDir];
    const dir = findPackage((m) => m.thetis?.type === HOST_TYPE && m.thetis.host?.name === name, bases);
    if (!dir) throw new CodedError(`no host package named ${name} among the packages in ${bases.join(" or ")}`, "not-found");
    this.dirs.set(name, dir);
    this.log(`host package ${name}: ${dir}`);
    return dir;
  }
}
