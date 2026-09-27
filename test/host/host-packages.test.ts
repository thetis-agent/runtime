// A host package runs in the daemon, so what "an edit is live on the next call" means there decides whether a
// fix to it needs a restart. Before 2026-09-27 only the entry was re-imported, and production's SSH keys page
// died on "./lib/ssh.js does not provide an export named isWithin" until the daemon restarted.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createKernel, defaultConfig, T, type Fences } from "../../src/index.js";
import { FileAssetStore } from "../../src/lib/assets.js";
import { memoryStore } from "../../src/lib/store.js";

const edit = (file: string, text: string, ahead: number) => {
  writeFileSync(file, text);
  const at = new Date(Date.now() + ahead * 1000);
  utimesSync(file, at, at);
};

test("a host package is fresh as a whole: an edited module its entry imports is live on the next call, and HostEnv.restart arms the latch with a row", async () => {
  const home = mkdtempSync(join(tmpdir(), "thetis-hostpkg-"));
  const shipped = join(home, "shipped");
  const pkg = join(shipped, "host-probe");
  mkdirSync(join(pkg, "lib"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@thetis/host-probe", version: "1.0.0", type: "module", main: "index.js", thetis: { type: "host", host: { name: "probe" } } }));
  writeFileSync(join(pkg, "index.js"), [
    'import * as lib from "./lib/check.js";',
    "export async function check() { return lib.isWithin ? lib.isWithin() : \"old\"; }",
    "export async function finish(args, env) { return env.restart(\"update: done\", \"alice\"); }",
    "export async function reload(args, env) { await env.reloadFence(\"bob\", { drain: true }); return \"reloaded\"; }",
  ].join("\n"));
  edit(join(pkg, "lib", "check.js"), "export const version = 1;\n", 1);
  const config = defaultConfig(home, join(home, "empty-installation"));
  config.systemPackages = {};
  config.systemPackagesDir = shipped;
  const reloaded: string[] = [];
  const fences: Fences = {
    async handle() { throw new Error("not needed"); },
    async request() { return undefined; },
    async close(user) { reloaded.push(`close ${user}`); },
  };
  try {
    const kernel = await createKernel(config, (c) => {
      c.bind(T.store, () => memoryStore());
      c.bind(T.assetStore, () => new FileAssetStore(join(home, "assets")));
      c.bind(T.fences, () => fences);
      c.bind(T.log, () => () => {});
    });
    try {
      assert.equal(await kernel.hosts.call("probe", "check", {}), "old");
      edit(join(pkg, "lib", "check.js"), "export const version = 2;\nexport const isWithin = () => \"new\";\n", 5);
      assert.equal(await kernel.hosts.call("probe", "check", {}), "new", "the edited lib file is live, the entry untouched");
      // Not the serving daemon, so the latch refuses; what matters is that the call reaches it and leaves a row.
      const armed = (await kernel.hosts.call("probe", "finish", {})) as { state: string; why?: string; message: string };
      assert.equal(armed.state, "refused");
      assert.match(armed.message, /nothing is going to happen/);
      const row = kernel.journal.tail(1, { kind: "restart.refused" })[0];
      assert.equal(row.actor, "alice");
      assert.deepEqual(row.data, { reason: "update: done", why: armed.why });
      kernel.users.create("bob");
      assert.equal(await kernel.hosts.call("probe", "reload", {}), "reloaded", "reloadFence takes { drain }");
    } finally {
      await kernel.shutdown();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
