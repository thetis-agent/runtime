// The storage driver is a package loaded here, on the host: the kernel holds only the `StoreDriver` interface,
// the way it holds `Fences` and never sees the sandbox. Which driver is `storage.driver` in the configuration.
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { STORAGE_TYPE, type Manifest, type Mount, type PackageRecord, type StoreDriver, type StoreFactory, type UserRecord } from "../contracts/index.js";
import type { Credential, KernelConfig, TokenRecord } from "../kernel/index.js";
import { readManifest } from "../kernel/packages/manifest.js";
import { assert, CodedError, errorMessage } from "../lib/error.js";
import type { SshGrant } from "../contracts/index.js";
import { StoreMirror } from "../lib/store.js";

/** The service plane's records, each namespace held in memory and written through. */
export interface Records {
  users: StoreMirror<UserRecord>;
  credentials: StoreMirror<Credential>;
  tokens: StoreMirror<TokenRecord>;
  registry: StoreMirror<PackageRecord>;
  mounts: StoreMirror<{ mounts: Mount[] }>;
  ssh: StoreMirror<{ ssh: SshGrant[] }>;
}

/**
 * Finds the driver package among the shipped and the promoted packages, imports its factory, opens the
 * store under `<home>/store`, and proves it works with one write before anything depends on it. A driver
 * that cannot write is the one failure to refuse at startup rather than discover at the first record.
 */
export async function loadStoreDriver(config: KernelConfig, log: (line: string) => void): Promise<StoreDriver> {
  const name = config.storage.driver;
  const dir = findPackage((m) => m.name === name, [config.systemPackagesDir, config.promotedPackagesDir]);
  assert(dir, `storage driver ${name} is not among the packages in ${config.systemPackagesDir} or ${config.promotedPackagesDir}`, "storage");
  const manifest = readManifest(dir);
  assert(manifest.thetis?.type === STORAGE_TYPE, `${name} is not a storage driver: its thetis.type is ${String(manifest.thetis?.type)}`, "storage");
  const mod = (await import(pathToFileURL(resolve(dir, manifest.main ?? "index.js")).href)) as Record<string, unknown>;
  const factory = mod[manifest.thetis.export ?? "createStore"];
  assert(typeof factory === "function", `${name} does not export the store factory ${manifest.thetis.export ?? "createStore"}`, "storage");
  const driver = await (factory as StoreFactory)({ root: resolve(config.home, "store"), log });
  try {
    const probe = driver.open("_probe");
    await probe.set("probe", { at: new Date().toISOString() });
    assert((await probe.get("probe")) !== undefined, "the document written was not read back");
    await probe.delete("probe");
    await probe.clear();
  } catch (err) {
    throw new CodedError(`storage driver ${name} cannot keep records under ${resolve(config.home, "store")}: ${errorMessage(err)}`, "storage");
  }
  return driver;
}

/**
 * The first directory whose package.json satisfies `match`, scanning each base in order, like the manager's
 * `systemPackageDir`. The real path, so a package reached through a link resolves its own imports from where
 * it lives. A manifest that does not parse is skipped, so one broken package hides nothing but itself.
 */
export function findPackage(match: (manifest: Manifest) => boolean, bases: string[]): string | undefined {
  for (const base of bases) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const file = resolve(base, entry, "package.json");
      if (!existsSync(file)) continue;
      try {
        if (match(readManifest(resolve(base, entry)))) return realpathSync(resolve(base, entry));
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

/** Reads every record once. Credentials and tokens are private namespaces: a file driver keeps them 0700/0600. */
export async function openRecords(driver: StoreDriver): Promise<Records> {
  return {
    users: await StoreMirror.open(driver.open("users")),
    credentials: await StoreMirror.open(driver.open("auth/credentials", { private: true })),
    tokens: await StoreMirror.open(driver.open("auth/tokens", { private: true })),
    registry: await StoreMirror.open(driver.open("registry")),
    mounts: await StoreMirror.open(driver.open("mounts")),
    ssh: await StoreMirror.open(driver.open("ssh")),
  };
}

/** Waits for every queued write to reach the store. Called on shutdown, before the driver closes. */
export async function flushRecords(records: Records): Promise<void> {
  await Promise.all(Object.values(records).map((m: StoreMirror<object>) => m.flush()));
}
