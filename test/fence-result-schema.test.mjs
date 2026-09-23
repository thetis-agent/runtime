import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig } from "../dist/src/kernel/config.js";
import { PackageManager } from "../dist/src/kernel/packages/manager.js";
import { PackageRegistry } from "../dist/src/kernel/packages/registry.js";
import { memoryStore, StoreMirror } from "../dist/src/lib/store.js";
import { UserspaceLayout } from "../dist/src/lib/userspace-layout.js";

test("package builds validate the fence exec reply before recording an install", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "thetis-exec-schema-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const registry = new PackageRegistry(await StoreMirror.open(memoryStore().open("registry")));
  let reply;
  const manager = new PackageManager(defaultConfig(home, "/project"), registry, { request: async () => reply });
  const userspace = new UserspaceLayout(home).ensure("alice");
  const dir = join(userspace.home, "packages/build");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@alice/build", version: "1.0.0", scripts: { build: "build" }, thetis: { type: "tool" } }));
  const actor = { id: "alice", role: "user", status: "active", createdAt: "now" };
  const install = () => manager.install(userspace, actor, "packages/build");
  for (reply of [null, [], { code: "0", stdout: "", stderr: "" }, { code: 0, stdout: [], stderr: "" }, { code: 0.5, stdout: "", stderr: "" }]) {
    await assert.rejects(install(), (error) => error.code === "build" && /exec reply/.test(error.message));
    assert.equal(registry.get("@alice/build"), undefined);
    assert.equal(existsSync(join(userspace.store, "node_modules/@alice/build")), false);
  }
  reply = { code: 1, stdout: "", stderr: "build failed" };
  await assert.rejects(install(), /command failed \(1\).*\n?build failed/s);
  reply = { code: 0, stdout: "built", stderr: "" };
  assert.equal((await install()).name, "@alice/build");
});
