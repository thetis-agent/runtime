// Which keys a reload can put into service, and the in-place write that is how it reaches the holders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyInPlace, changedKeys, classifyChanges, tierOf, type ConfigTier } from "../../src/lib/config-tiers.js";

const TIERS: Record<string, ConfigTier> = { model: "dispatch", fence: "fence", door: "boot" };

test("changedKeys reports dotted paths, and compares arrays by value", () => {
  assert.deepEqual(changedKeys({ a: 1 }, { a: 1 }), []);
  assert.deepEqual(changedKeys({ a: { b: 1 } }, { a: { b: 2 } }), ["a.b"]);
  assert.deepEqual(changedKeys({ phases: ["x", "y"] }, { phases: ["x", "y"] }), [], "an equal array is not a change");
  assert.deepEqual(changedKeys({ phases: ["x"] }, { phases: ["y"] }), ["phases"]);
  assert.deepEqual(changedKeys({ a: 1 }, {}), ["a"], "a key that went away changed");
  // An array of objects has to compare by value, or it never equals itself and every reload reports a
  // change that did not happen. `registries` is exactly this shape and did exactly that.
  const registries = [{ name: "thetis", url: "https://example/packages.git" }];
  assert.deepEqual(changedKeys({ registries }, { registries: [{ ...registries[0] }] }), []);
  assert.deepEqual(changedKeys({ registries }, { registries: [{ ...registries[0], url: "other" }] }), ["registries"]);
  assert.deepEqual(changedKeys({ a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 2 }] } }), []);
  assert.deepEqual(changedKeys({}, { a: 1 }), ["a"]);
});

test("a key is answered by the longest declared prefix, and an undeclared key is boot", () => {
  assert.equal(tierOf("fence.limits.memoryMb", TIERS), "fence");
  assert.equal(tierOf("model", TIERS), "dispatch");
  // Never assume a key nobody declared is live: a reload that silently ignored it is the failure this
  // whole mechanism exists to remove.
  assert.equal(tierOf("somethingNew", TIERS), "boot");
  assert.equal(tierOf("fence", { "fence.docker": "fence" }), "boot", "a deeper declaration does not answer for its parent");
});

test("changes are grouped by what it takes to put them into service", () => {
  const before = { model: "a", fence: { docker: "auto" }, door: { port: 8777 }, untouched: 1 };
  const after = { model: "b", fence: { docker: "off" }, door: { port: 9000 }, untouched: 1 };
  assert.deepEqual(classifyChanges(before, after, TIERS), { dispatch: ["model"], fence: ["fence.docker"], boot: ["door.port"] });
});

test("applyInPlace updates every holder of the object and of anything inside it", () => {
  // This is the whole of the dispatch tier. The kernel binds one configuration object at boot and every
  // consumer keeps it, so replacing the object would update nobody and mutating it updates everybody.
  const config = { model: "a", fence: { docker: "auto", limits: { memoryMb: 1024 } }, gone: true };
  const heldWhole = config;
  const heldInner = config.fence;
  const heldLimits = config.fence.limits;
  applyInPlace(config, { model: "b", fence: { docker: "off", limits: { memoryMb: "auto" } } });
  assert.equal(heldWhole.model, "b");
  assert.equal(heldInner.docker, "off", "a holder of a sub-object sees the change too");
  assert.equal(heldLimits.memoryMb, "auto", "and so does a holder two levels down");
  assert.ok(!("gone" in config), "a key removed from the file goes back to its default rather than lingering");
});
