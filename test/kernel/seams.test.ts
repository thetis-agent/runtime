// The daemon's seams, as lists. Each is a shape the daemon holds for its life: the operations a fence
// answers, the methods a fence may ask the kernel, the operator table, the door's routes, the constants
// contracts export at runtime, and the configuration keys with a declared tier. A change to any of them is
// a change to the daemon, so it is made here first, on purpose, and the test says which seam moved.
// Everything else a package needs travels through these as data the daemon never interprets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fences, PackageInfo, SessionRecord, Userspace } from "../../src/contracts/index.js";
import { CONFIG_TIERS, defaultConfig } from "../../src/kernel/config.js";
import { Enumerator } from "../../src/kernel/pipeline/enumerator.js";
import { PipelineRunner } from "../../src/kernel/pipeline/runner.js";
import type { PackageManager } from "../../src/kernel/packages/manager.js";
import { SESSION_ID } from "../../src/kernel/sessions/api.js";
import { textContent } from "../../src/lib/content.js";
import { Journal } from "../../src/lib/journal.js";
import { SessionStore } from "../../src/lib/session-store.js";
import { UserspaceLayout } from "../../src/lib/userspace-layout.js";

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../src");
const source = (rel: string): string => readFileSync(resolve(SOURCE, rel), "utf8");

/** Every `case "name":` in a file, in order. */
const cases = (rel: string): string[] => [...source(rel).matchAll(/case "([a-zA-Z.]+)":/g)].map((m) => m[1]).sort();

test("the fence answers exactly these operations", () => {
  const text = source("userspace-agent/agent.ts");
  const block = text.slice(text.indexOf("const ops:"), text.indexOf("function isOp"));
  const ops = [...block.matchAll(/^ {2}"?([a-z.]+)"?:/gm)].map((m) => m[1]).sort();
  assert.deepEqual(ops, ["enumerate", "exec", "ping", "provider.call", "provider.models", "service.start", "service.stop", "shutdown", "step"]);
});

test("a fence may ask the kernel exactly these methods", () => {
  assert.deepEqual(cases("kernel/rpc.ts"), [
    "assets.put", "assets.read",
    "auth.authenticate", "auth.login", "auth.logout",
    "config.effective", "config.set", "config.show", "config.unset",
    "models",
    "packages.catalog", "packages.delete", "packages.install", "packages.list", "packages.unfork", "packages.uninstall",
    "providers.call",
    "sessions.ask", "sessions.askText", "sessions.cancel", "sessions.complete", "sessions.create", "sessions.delete", "sessions.inspect", "sessions.list", "sessions.send", "sessions.watch",
    "store.clear", "store.delete", "store.get", "store.list", "store.set",
    // 2026-09-27: a harness asks at each round boundary whether the installation wants the turn to stop there.
    "turns.yielding",
  ]);
});

/**
 * The resume is not a verb: it is `sessions.send(id, [])`, a turn with no input, which runs the whole pipeline
 * over the saved conversation and appends nothing. The Retry button, the automatic resume after a restart or a
 * reload, `resume_subagent` and the workflows engine all stand on this, so it is pinned here as a seam.
 */
test("a turn with no input appends nothing and runs the pipeline", async () => {
  const home = mkdtempSync(join(tmpdir(), "thetis-seam-"));
  try {
    const steps: string[] = [];
    let seen: unknown[] = [];
    const fences = {
      request: async (_us: Userspace, _op: string, payload: { export: string; ctx: { conversation: unknown[] } }) => {
        steps.push(payload.export);
        seen = payload.ctx.conversation;
        return payload.export === "execute" ? { conversation: [...payload.ctx.conversation, { role: "assistant", content: textContent("continued") }] } : undefined;
      },
    } as unknown as Fences;
    const plan = [{ name: "@a/h", version: "1", type: "harness", description: "", root: "/x", thetis: { type: "harness", steps: [{ id: "p", phase: "prompt", export: "prompt" }, { id: "e", phase: "execute", export: "execute" }] } }] as PackageInfo[];
    const config = defaultConfig(home, "/proj");
    const store = new SessionStore(SESSION_ID);
    const runner = new PipelineRunner(config, { effective: async () => ({}) }, new Enumerator(config, fences), { installed: () => plan } as unknown as PackageManager, fences, store, new Journal(home));
    const us = new UserspaceLayout(home).ensure("bob");
    const conversation = [{ role: "user" as const, content: textContent("go") }, { role: "assistant" as const, content: textContent("half") }];
    const session: SessionRecord = { id: "s_1", user: "bob", createdAt: "0", updatedAt: "0", turns: 1, conversation, harness: {} };
    await runner.runTurn(us, session, [], () => {});
    assert.deepEqual(steps, ["prompt", "execute"], "every step ran");
    assert.deepEqual(seen, conversation, "the steps saw the saved conversation as it was");
    assert.deepEqual(store.load(us.sessions, "s_1")!.conversation.map((m) => m.role), ["user", "assistant", "assistant"], "and the only thing added is what the steps added");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the operator table is exactly these methods, plus host packages under host.<name>.<export>", () => {
  assert.deepEqual(cases("kernel/control.ts"), [
    "config.get", "config.list", "config.reload", "config.set", "config.show", "config.unset",
    "fence.reload",
    "journal.tail",
    "models",
    "packages.install", "packages.installEveryone", "packages.list", "packages.promote", "packages.unfork", "packages.uninstall", "packages.unmarkEveryone",
    "ping",
    "restart.cancel", "restart.request", "restart.status",
    "sessions.cancel", "sessions.create", "sessions.delete", "sessions.inspect", "sessions.list", "sessions.send",
    "status",
    "users.create", "users.list", "users.passwd", "users.remove", "users.setRole", "users.setStatus",
  ]);
  assert.match(source("kernel/control.ts"), /"host\."/, "host packages are dispatched by prefix");
});

test("the door routes exactly the login page and each person's gateway", () => {
  const text = source("door/index.ts");
  const literals = [...text.matchAll(/path(?:\.startsWith\(| === )"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(literals, ["/", "/login", "/login/", "/logout"]);
  assert.match(text, /`\/\$\{user\}`/, "everything else is a person's own gateway");
});

test("contracts export strings and nothing else at runtime", async () => {
  const mod = (await import("../../src/contracts/index.js")) as Record<string, unknown>;
  const runtime = Object.entries(mod).filter(([, v]) => v !== undefined);
  assert.deepEqual(runtime.map(([k]) => k).sort(), ["HOST_TYPE", "STORAGE_TYPE", "SYSTEM_SCOPE", "SYSTEM_USER"]);
  for (const [k, v] of runtime) assert.equal(typeof v, "string", `${k} is a string constant`);
});

test("every configuration key has a declared tier, and the kernel ships no per-package defaults", () => {
  assert.deepEqual(Object.keys(CONFIG_TIERS).sort(), ["control", "door", "enumerator", "fence", "model", "packages", "phases", "requestTimeoutMs", "storage", "systemPackages"]);
  const config = defaultConfig("/tmp/h", "/tmp/p");
  assert.deepEqual(config.packages, {});
  assert.deepEqual(config.phases, ["history", "prompt", "tools", "call", "execute", "after"]);
  // The keys the file may carry are the declared ones; the derived paths come from the checkout.
  const derived = new Set(["home", "projectRoot", "systemPackagesDir", "promotedPackagesDir", "sharedDir", "agentPath", "envFile"]);
  const fileKeys = Object.keys(config).filter((k) => !derived.has(k)).sort();
  // `enumerator` is optional and absent by default; every other key the file may carry has a tier.
  assert.deepEqual([...fileKeys, "enumerator"].sort(), Object.keys(CONFIG_TIERS).sort(), "a key in the file has a tier, or it is silently boot");
});
