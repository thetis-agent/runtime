import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { StoreDriver } from "../contracts/index.js";

/** What every case round-trips: one of each value shape a document may hold. */
const SAMPLE = {
  text: "two\nlines with ünïcödé and 日本語 and an emoji 🎉",
  quoted: 'she said "hi" and \'bye\'',
  int: 42,
  negative: -7,
  float: 3.14159,
  yes: true,
  no: false,
  scalars: ["a", 1, true, -2.5],
  rows: [{ id: 1, name: "one" }, { id: 2, name: "two", tags: ["x", "y"] }],
  nested: { deep: { deeper: { value: "here", n: 0 } } },
  emptyObject: {},
  emptyArray: [],
};

const BAD_IDS = ["..", ".", "a//b", "/a", "a/", "x".repeat(129), "a/../b"];

/**
 * The cases a storage driver passes. Each opens a fresh driver so a failed case cannot leak into the
 * next. A file-backed driver exposes its root as a `root` string on the driver; the private-namespace
 * case walks it and is skipped when there is none.
 */
export function storeConformance(name: string, open: () => Promise<StoreDriver>, close?: (d: StoreDriver) => Promise<void>): void {
  const withDriver = (fn: (d: StoreDriver, t: TestContext) => Promise<void>) => async (t: TestContext) => {
    const d = await open();
    try {
      await fn(d, t);
    } finally {
      await close?.(d);
      await d.close?.();
    }
  };

  test(`${name}: a nested document round-trips`, withDriver(async (d) => {
    const s = d.open("round/trip");
    await s.set("doc", SAMPLE);
    assert.deepEqual(await s.get("doc"), SAMPLE);
  }));

  test(`${name}: a large array round-trips`, withDriver(async (d) => {
    const s = d.open("large");
    const numbers = Array.from({ length: 10_000 }, (_, i) => i * 1.5 - 100);
    await s.set("n", { numbers });
    assert.deepEqual(await s.get("n"), { numbers });
  }));

  test(`${name}: list answers every key, or those under a prefix`, withDriver(async (d) => {
    const s = d.open("listing");
    await s.set("a", { n: 1 });
    await s.set("ab", { n: 2 });
    await s.set("b/c", { n: 3 });
    assert.deepEqual((await s.list()).sort(), ["a", "ab", "b/c"]);
    assert.deepEqual((await s.list("a")).sort(), ["a", "ab"]);
    assert.deepEqual(await s.list("b/"), ["b/c"]);
    assert.deepEqual(await s.list("zzz"), []);
  }));

  test(`${name}: a missing key is undefined and delete is idempotent`, withDriver(async (d) => {
    const s = d.open("missing");
    assert.equal(await s.get("nope"), undefined);
    await s.set("k", { n: 1 });
    await s.delete("k");
    await s.delete("k");
    assert.equal(await s.get("k"), undefined);
    assert.deepEqual(await s.list(), []);
  }));

  test(`${name}: clear removes the namespace and the namespaces beneath it`, withDriver(async (d) => {
    await d.open("a").set("k", { n: 1 });
    await d.open("a/b").set("k", { n: 2 });
    await d.open("a/b/c").set("k", { n: 3 });
    await d.open("ab").set("k", { n: 4 });
    await d.open("a").clear();
    assert.equal(await d.open("a").get("k"), undefined);
    assert.equal(await d.open("a/b").get("k"), undefined);
    assert.deepEqual(await d.open("a/b/c").list(), []);
    assert.deepEqual(await d.open("ab").get("k"), { n: 4 }, "a sibling that merely shares the prefix stays");
  }));

  test(`${name}: an invalid id is refused before it becomes anything`, withDriver(async (d) => {
    const invalid = (err: unknown) => (err as { code?: string }).code === "invalid";
    for (const id of BAD_IDS) {
      assert.throws(() => d.open(id), invalid, `open(${JSON.stringify(id)})`);
      await assert.rejects(() => d.open("ok").get(id), invalid, `get(${JSON.stringify(id)})`);
      await assert.rejects(() => d.open("ok").set(id, { n: 1 }), invalid, `set(${JSON.stringify(id)})`);
    }
  }));

  test(`${name}: a document is an object with no null in it`, withDriver(async (d) => {
    const s = d.open("shape");
    const invalid = (err: unknown) => (err as { code?: string }).code === "invalid";
    await assert.rejects(() => s.set("k", { a: null }), invalid);
    await assert.rejects(() => s.set("k", { a: { b: [1, null] } }), invalid);
    await assert.rejects(() => s.set("k", [1, 2] as unknown as object), invalid);
    assert.deepEqual(await s.list(), [], "nothing was written");
  }));

  test(`${name}: a private namespace is unreadable to anyone else`, withDriver(async (d, t) => {
    const root = (d as { root?: unknown }).root;
    if (typeof root !== "string") {
      t.skip("the driver reports no root");
      return;
    }
    await d.open("private/deep", { private: true }).set("a/b", { n: 1 });
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        const mode = statSync(path).mode & 0o777;
        if (entry.isDirectory()) {
          assert.equal(mode, 0o700, `${path} is mode ${mode.toString(8)}`);
          walk(path);
        } else {
          assert.equal(mode, 0o600, `${path} is mode ${mode.toString(8)}`);
        }
      }
    };
    assert.equal(statSync(join(root, "private")).mode & 0o777, 0o700);
    walk(join(root, "private"));
  }));

  test(`${name}: concurrent writes to one key end with one of them`, withDriver(async (d) => {
    const s = d.open("race");
    const docs = Array.from({ length: 50 }, (_, i) => ({ i, payload: "x".repeat(i * 10) }));
    await Promise.all(docs.map((doc) => s.set("k", doc)));
    const got = await s.get("k");
    assert.ok(docs.some((doc) => JSON.stringify(doc) === JSON.stringify(got)), "the result is one of the written documents");
    assert.deepEqual(await s.list(), ["k"]);
  }));

  test(`${name}: a key with a slash works`, withDriver(async (d) => {
    const s = d.open("packages");
    await s.set("@thetis/exa", { installed: true });
    assert.deepEqual(await s.get("@thetis/exa"), { installed: true });
    assert.deepEqual(await s.list("@thetis/"), ["@thetis/exa"]);
    await s.delete("@thetis/exa");
    assert.deepEqual(await s.list(), []);
  }));
}
