// The daemon's seams, as lists. Each is a shape the daemon holds for its life: the operations a fence
// answers, the methods a fence may ask the kernel, the operator table, the door's routes, the constants
// contracts export at runtime, and the configuration keys with a declared tier. A change to any of them is
// a change to the daemon, so it is made here first, on purpose, and the test says which seam moved.
// Everything else a package needs travels through these as data the daemon never interprets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_TIERS, defaultConfig } from "../../src/kernel/config.js";

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
    "auth.authenticate", "auth.login", "auth.logout",
    "config.effective", "config.set", "config.show", "config.unset",
    "models",
    "packages.delete", "packages.install", "packages.list", "packages.unfork", "packages.uninstall",
    "providers.call",
    "sessions.ask", "sessions.cancel", "sessions.create", "sessions.delete", "sessions.inspect", "sessions.list", "sessions.send", "sessions.watch",
    "store.clear", "store.delete", "store.get", "store.list", "store.set",
  ]);
});

test("the operator table is exactly these methods, plus host packages under host.<name>.<export>", () => {
  assert.deepEqual(cases("kernel/control.ts"), [
    "config.get", "config.list", "config.reload", "config.set", "config.show", "config.unset",
    "fence.reload",
    "journal.tail",
    "models",
    "packages.install", "packages.installEveryone", "packages.list", "packages.promote", "packages.unfork", "packages.uninstall",
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
