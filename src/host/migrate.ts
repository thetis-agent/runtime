// The records used to be four JSON files in the data directory. They are documents in the store now, and
// a daemon refuses to start while the files are still there: importing silently at boot would make two
// copies of the truth, and the operator would not know which one a repair should touch.
import { existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import type { Mount, PackageRecord, UserRecord } from "../contracts/index.js";
import type { Credential, KernelConfig, TokenRecord } from "../kernel/index.js";
import { assert } from "../lib/error.js";
import { readJson } from "../lib/json.js";
import { loadStoreDriver } from "./store.js";

export const LEGACY_FILES = ["users.json", "auth.json", "registry.json", "mounts.json"];

export interface MigrationReport {
  /** Documents written, per file. */
  imported: Record<string, number>;
  /** Files that were not there. */
  skipped: string[];
}

/** Throws with code `invalid` while any legacy file is in the home, naming the command that moves them. */
export function assertMigrated(home: string): void {
  const found = LEGACY_FILES.filter((f) => existsSync(resolve(home, f)));
  assert(found.length === 0, `legacy records found in ${home} (${found.join(", ")}): run \`thetis migrate\``, "invalid");
}

/**
 * Imports each legacy file into its namespaces and renames it `<file>.migrated`. A file that is not there
 * is skipped, so running it twice imports nothing the second time. The daemon must not be running.
 */
export async function migrateStore(config: KernelConfig, log: (line: string) => void): Promise<MigrationReport> {
  const driver = await loadStoreDriver(config, log);
  const report: MigrationReport = { imported: {}, skipped: [] };
  const take = async <T>(file: string, put: (data: T) => Promise<number>) => {
    const path = resolve(config.home, file);
    if (!existsSync(path)) return void report.skipped.push(file);
    report.imported[file] = await put(readJson<T>(path, {} as T));
    renameSync(path, `${path}.migrated`);
  };
  const fill = async <T extends object>(namespace: string, docs: Record<string, T>, isPrivate = false) => {
    const space = driver.open(namespace, { private: isPrivate });
    for (const [key, doc] of Object.entries(docs)) await space.set(key, doc);
    return Object.keys(docs).length;
  };
  await take<Record<string, UserRecord>>("users.json", (users) => fill("users", users));
  await take<{ credentials?: Record<string, Credential>; tokens?: Record<string, TokenRecord> }>("auth.json", async (auth) => {
    return (await fill("auth/credentials", auth.credentials ?? {}, true)) + (await fill("auth/tokens", auth.tokens ?? {}, true));
  });
  await take<Record<string, PackageRecord>>("registry.json", (records) => fill("registry", records));
  await take<Record<string, Mount[]>>("mounts.json", (mounts) => {
    const docs = Object.fromEntries(Object.entries(mounts).filter(([, list]) => list.length).map(([user, list]) => [user, { mounts: list }]));
    return fill("mounts", docs);
  });
  await driver.close?.();
  return report;
}
