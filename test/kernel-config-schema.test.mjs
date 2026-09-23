import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig, loadConfig, packagesLayer } from "../dist/src/kernel/config.js";

function withConfig(patch, run) {
  const home = mkdtempSync(join(tmpdir(), "thetis-config-schema-"));
  try {
    writeFileSync(join(home, "thetis.config.json"), JSON.stringify(patch));
    return run(home);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

for (const [patch, path] of [
  [{ phases: ["history", 7] }, /phases.1/],
  [{ fence: "none" }, /fence/],
  [{ fence: { limits: { memoryMb: false } } }, /fence.limits.memoryMb/],
  [{ fence: { limits: { pids: 1.5 } } }, /fence.limits.pids/],
  [{ fence: { readOnly: [42] } }, /fence.readOnly.0/],
  [{ control: { allowRestart: "false" } }, /control.allowRestart/],
  [{ door: { port: 65536 } }, /door.port/],
  [{ requestTimeoutMs: 0 }, /requestTimeoutMs/],
  [{ systemPackages: { alice: "@thetis/harness-core" } }, /systemPackages.alice/],
  [{ enumerator: { package: "@local/custom", export: null } }, /enumerator.export/],
]) {
  test(`kernel config rejects malformed ${JSON.stringify(patch)}`, () => {
    withConfig(patch, (home) => assert.throws(() => loadConfig(home, "/project", {}), path));
  });
}

for (const packages of [[], null, { "@local/tool": [] }, { "@local/tool": "false" }]) {
  test(`package config file layer validates ${JSON.stringify(packages)}`, () => {
    withConfig({ packages }, (home) => assert.throws(() => packagesLayer(home), /packages/));
  });
}

test("kernel config merges partial nested defaults and retains deferred package variables", () => {
  withConfig({ envFile: "private.env", fence: { limits: { pids: 12 }, docker: "${DOCKER}" }, door: { port: 0 }, control: { allowRestart: false }, packages: { "@local/tool": { secret: "${TOKEN}" } }, extension: { future: true } }, (home) => {
    const config = loadConfig(home, "/project", { DOCKER: "off", TOKEN: "secret" });
    assert.deepEqual(config.fence.limits, { ...defaultConfig(home, "/project").fence.limits, pids: 12 });
    assert.equal(config.fence.docker, "off");
    assert.equal(config.door.host, "127.0.0.1");
    assert.equal(config.door.port, 0);
    assert.equal(config.control.minUptimeSecs, 60);
    assert.equal(config.envFile, join(home, "private.env"));
    assert.equal(config.projectRoot, "/project");
    assert.equal(config.packages["@local/tool"].secret, "${TOKEN}");
    assert.deepEqual(config.extension, { future: true });
  });
});

test("kernel config checks interpolated enum values before returning a typed configuration", () => {
  withConfig({ fence: { sandbox: "${SANDBOX}" } }, (home) => {
    assert.equal(loadConfig(home, "/project", { SANDBOX: "none" }).fence.sandbox, "none");
    assert.throws(() => loadConfig(home, "/project", { SANDBOX: "typo" }), /fence.sandbox/);
    assert.throws(() => loadConfig(home, "/project", {}), /fence.sandbox/);
  });
});
