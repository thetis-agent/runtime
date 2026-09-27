// 2026-09-27: the lib halves of "nothing lost, one-button updates": a package graph imported fresh as a whole,
// the fork's recorded base and what it says about switching back, the config file's one-time tidy, and the
// session index's copy of why a turn stopped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "../../src/contracts/index.js";
import { defaultConfig } from "../../src/kernel/config.js";
import { textContent } from "../../src/lib/content.js";
import { tidyConfig } from "../../src/lib/config-tidy.js";
import { cancelReason, cancelWhy } from "../../src/lib/error.js";
import { importFresh } from "../../src/lib/fresh-import.js";
import { FORK_BASE, forkPackage, forkState, samePackage } from "../../src/lib/pkg-fs.js";
import { SessionStore, summarize } from "../../src/lib/session-store.js";

const tmp = () => mkdtempSync(join(tmpdir(), "thetis-rel-"));
/** Writes a file and moves its modification time on, so a fingerprint sees the change whatever the clock's grain. */
const edit = (file: string, text: string, ahead: number) => {
  writeFileSync(file, text);
  const at = new Date(Date.now() + ahead * 1000);
  utimesSync(file, at, at);
};

test("importFresh: a change to any file of the package -- not only its entry -- is a new module graph; an unchanged package is the graph already loaded; a dependency outside it keeps one copy", async () => {
  const root = tmp();
  try {
    const pkg = join(root, "pkg");
    mkdirSync(join(pkg, "lib"), { recursive: true });
    mkdirSync(join(root, "dep"));
    writeFileSync(join(root, "dep", "index.js"), "export const made = {};\n");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@t/fresh", type: "module", main: "index.js" }));
    writeFileSync(join(pkg, "index.js"), 'export * from "./lib/inner.js";\nexport { made } from "../dep/index.js";\n');
    edit(join(pkg, "lib", "inner.js"), "export const value = 1;\n", 1);
    // Reached through a link, as a userspace's store reaches a shipped package.
    symlinkSync(pkg, join(root, "link"));
    const entry = join(root, "link", "index.js");
    const first = await importFresh(entry, join(root, "link"));
    assert.equal(first.value, 1);
    assert.equal(await importFresh(entry, join(root, "link")), first, "nothing changed: the same module");
    // The production failure: an entry that asks a lib file for an export the first-loaded copy did not have.
    edit(join(pkg, "lib", "inner.js"), "export const value = 2;\nexport const isWithin = () => true;\n", 5);
    const second = await importFresh(entry, join(root, "link"));
    assert.equal(second.value, 2, "the edited lib file is live without the entry changing");
    assert.equal(typeof second.isWithin, "function");
    assert.equal(second.made, first.made, "a module outside the package is not duplicated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("forkState: a fork records its base, and says whether switching back to the origin loses anything", () => {
  const root = tmp();
  try {
    const origin = join(root, "origin");
    mkdirSync(join(origin, "dist"), { recursive: true });
    writeFileSync(join(origin, "package.json"), JSON.stringify({ name: "@thetis/x", version: "1.0.0", thetis: { type: "tool" } }));
    writeFileSync(join(origin, "index.js"), "one\n");
    writeFileSync(join(origin, "dist", "a.js"), "built\n");
    const fork = join(root, "fork");
    forkPackage({ from: origin, to: fork, name: "@alice/x", version: "1.0.0-fork.0", root, origin: { name: "@thetis/x", version: "1.0.0" } } as never);
    assert.ok(samePackage(fork, origin), "the recorded base is not part of the package");
    assert.equal(forkState(fork, origin), "identical");
    writeFileSync(join(fork, "index.js"), "two\n");
    assert.equal(forkState(fork, origin), "diverged", "a change the origin does not have");
    writeFileSync(join(origin, "index.js"), "two\n");
    assert.equal(forkState(fork, origin), "identical", "the origin made the same change");
    writeFileSync(join(origin, "other.js"), "new upstream\n");
    assert.equal(forkState(fork, origin), "superseded", "every change the fork made is in the origin, which has moved on");
    writeFileSync(join(fork, "dist", "a.js"), "hand-edited build\n");
    assert.equal(forkState(fork, origin), "diverged", "an edit to built output counts: a fork that cannot rebuild is edited there");
    rmSync(join(fork, FORK_BASE));
    assert.equal(forkState(fork, origin), "unknown", "a fork made before bases were recorded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tidyConfig: values equal to their default and package keys the store holds come out; a list that replaces its default whole stays whole", () => {
  const defaults = (({ home, projectRoot, systemPackagesDir, promotedPackagesDir, sharedDir, agentPath, envFile, packages, ...rest }) => rest)(defaultConfig("/h", "/p"));
  const file = {
    model: defaults.model,
    phases: ["history", "execute"],
    systemPackages: { "*": [...defaults.systemPackages["*"]], bob: ["@x/y"] },
    door: { host: "0.0.0.0", port: 8777 },
    fence: { sandbox: "auto", network: "auto", limits: { memoryMb: "auto", pids: 1024, cpuPercent: 200 }, docker: "auto" },
    control: { allowRestart: true, minUptimeSecs: 60, quietWaitMs: 120_000 },
    requestTimeoutMs: 600_000,
    envFile: ".env.test",
    packages: {
      "@thetis/exa": { apiKey: "${EXA}", defaults: { n: 3 } },
      "@thetis/marketplace": { refreshMinutes: 60, registries: ["a"] },
    },
  };
  const { next, removed } = tidyConfig({
    file,
    defaults,
    merged: ["storage", "fence", "door", "control"],
    packageDefault: (name, key) => (name === "@thetis/marketplace" && key === "refreshMinutes" ? 60 : undefined),
    shadowed: (name, key, value) => name === "@thetis/exa" && typeof value !== "object",
  });
  assert.deepEqual(next, {
    phases: ["history", "execute"],
    systemPackages: file.systemPackages,
    door: { host: "0.0.0.0" },
    fence: { limits: { pids: 1024 } },
    envFile: ".env.test",
    packages: { "@thetis/exa": { defaults: { n: 3 } }, "@thetis/marketplace": { registries: ["a"] } },
  });
  assert.deepEqual(removed.map((r) => `${r.path}:${r.why}`).sort(), [
    "control:default", "door.port:default", "fence.docker:default", "fence.limits.cpuPercent:default", "fence.limits.memoryMb:default",
    "fence.network:default", "fence.sandbox:default", "model:default", "packages.@thetis/exa.apiKey:store", "packages.@thetis/marketplace.refreshMinutes:default", "requestTimeoutMs:default",
  ]);
});

test("session index: a record's interrupted mark is copied in brief; `unfinished` finds the records a dead process left mid-turn by their text alone", () => {
  const dir = tmp();
  try {
    const store = new SessionStore(/^s_[a-f0-9]+$/);
    const base: SessionRecord = { id: "s_1", user: "bob", createdAt: "0", updatedAt: "0", turns: 1, conversation: [{ role: "user", content: textContent('a "turn": { that is text') }], harness: { turn: { nested: true } } };
    store.save(dir, base);
    store.save(dir, { ...base, id: "s_2", turn: { id: "t_9", startedAt: "0" } });
    store.save(dir, { ...base, id: "s_3", interrupted: { turn: "t_1", at: "1", error: { message: "cut", code: "provider", kind: "timeout" }, why: "provider", resumes: 1 } });
    assert.deepEqual(store.unfinished(dir), ["s_2"], "a nested or quoted `turn` is not the marker");
    assert.deepEqual(summarize(store.load(dir, "s_3")!).interrupted, { why: "provider", at: "1", resumes: 1, kind: "timeout" });
    const legacy = { ...base, interrupted: { turn: "t_0", at: "2", error: { message: "fence died" } } };
    assert.deepEqual(summarize(legacy).interrupted, { why: "failed", at: "2" }, "a mark written before `why` existed reads as a failed step");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelReason: the signal carries whose cancel it was; a bare abort is a person's Stop", () => {
  const c = new AbortController();
  c.abort(cancelReason("restart"));
  assert.equal(cancelWhy(c.signal), "restart");
  assert.equal((c.signal.reason as { code: string }).code, "cancelled");
  const bare = new AbortController();
  bare.abort();
  assert.equal(cancelWhy(bare.signal), "stop");
});
