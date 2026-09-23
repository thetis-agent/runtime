import { test } from "node:test";
import assert from "node:assert/strict";
import type { Store } from "../../src/contracts/index.js";
import { StoreMirror, assertStoreDoc, assertStoreId, memoryStore, storeId } from "../../src/lib/store.js";
import { storeConformance } from "../../src/lib/store-conformance.js";

const invalid = (err: unknown) => (err as { code?: string }).code === "invalid";

test("store ids: package names, userspace paths and hex tokens pass; dots, empty segments and long segments do not", () => {
  for (const id of ["@thetis/foo", "userspaces/alice/@alice/x/notes", "a".repeat(64), "deadbeef".repeat(8), "x".repeat(128), "s_01.v2"]) {
    assert.doesNotThrow(() => assertStoreId(id), id);
  }
  for (const id of ["..", ".", "a/../b", "a//b", "/a", "a/", "", "x".repeat(129), ".hidden", "a b", "a/b/".repeat(9) + "c"]) {
    assert.throws(() => assertStoreId(id), invalid, JSON.stringify(id));
  }
  assert.equal(storeId("userspaces", "alice", "@thetis/exa", "default"), "userspaces/alice/@thetis/exa/default");
  assert.throws(() => storeId("userspaces", "../etc"), invalid);
});

test("store documents: an object with no null anywhere, under the size cap", () => {
  assert.doesNotThrow(() => assertStoreDoc({ a: [1, { b: "c" }], d: {}, e: [] }));
  assert.throws(() => assertStoreDoc([1, 2]), invalid, "an array");
  assert.throws(() => assertStoreDoc(null), invalid, "null");
  assert.throws(() => assertStoreDoc("text"), invalid, "a string");
  assert.throws(() => assertStoreDoc({ a: { b: [1, null] } }), /doc\.a\.b\[1\] is null/, "null at depth, named");
  assert.throws(() => assertStoreDoc({ a: undefined }), invalid, "undefined");
  assert.throws(() => assertStoreDoc({ a: Number.NaN }), invalid, "a number JSON would turn into null");
  assert.throws(() => assertStoreDoc({ a: "x".repeat(300) }, 256), /bytes; the limit is 256/);
  assert.doesNotThrow(() => assertStoreDoc({ a: "x".repeat(300) }, Infinity));
});

test("memory store: clear removes the namespace and those beneath it", async () => {
  const d = memoryStore();
  await d.open("a").set("k", { n: 1 });
  await d.open("a/b").set("k", { n: 2 });
  await d.open("ab").set("k", { n: 3 });
  await d.open("a").clear();
  assert.equal(await d.open("a").get("k"), undefined);
  assert.equal(await d.open("a/b").get("k"), undefined);
  assert.deepEqual(await d.open("ab").get("k"), { n: 3 });
  // A document is copied in and out: a caller cannot change the stored one behind the store's back.
  const doc = { list: [1] };
  await d.open("copy").set("k", doc);
  doc.list.push(2);
  const got = await d.open("copy").get<{ list: number[] }>("k");
  assert.deepEqual(got, { list: [1] });
  got?.list.push(3);
  assert.deepEqual(await d.open("copy").get("k"), { list: [1] });
});

/** A store that records the order its writes arrive in, and makes the first one slow. */
function recording(store: Store): { store: Store; calls: string[] } {
  const calls: string[] = [];
  let first = true;
  return {
    calls,
    store: {
      ...store,
      async set(key, doc) {
        if (first) {
          first = false;
          await new Promise((r) => setTimeout(r, 20));
        }
        calls.push(`set ${key}`);
        await store.set(key, doc);
      },
      async delete(key) {
        calls.push(`delete ${key}`);
        await store.delete(key);
      },
    },
  };
}

test("store mirror: loads what is there, answers from memory, and writes through in order", async () => {
  const d = memoryStore();
  const plain = d.open("mirror");
  await plain.set("existing", { n: 0 });
  const { store, calls } = recording(plain);
  const m = await StoreMirror.open<{ n: number }>(store);
  assert.deepEqual(m.all(), [["existing", { n: 0 }]]);
  m.set("a", { n: 1 });
  m.set("b", { n: 2 });
  m.delete("a");
  m.set("a/c", { n: 3 });
  // The map is the truth at once; the store has not seen anything yet because the first write is slow.
  assert.equal(m.has("a"), false);
  assert.deepEqual(m.get("b"), { n: 2 });
  assert.deepEqual(m.keys("a"), ["a/c"]);
  assert.deepEqual(calls, []);
  await m.flush();
  assert.deepEqual(calls, ["set a", "set b", "delete a", "set a/c"]);
  assert.deepEqual((await plain.list()).sort(), ["a/c", "b", "existing"]);
  assert.deepEqual(await plain.get("b"), { n: 2 });
  // A later change to the document passed in does not reach the write.
  const doc = { n: 4 };
  m.set("d", doc);
  doc.n = 5;
  await m.flush();
  assert.deepEqual(await plain.get("d"), { n: 4 });
});

test("store mirror: a failed write is reported and the queue goes on", async () => {
  const d = memoryStore();
  const plain = d.open("failing");
  const errors: string[] = [];
  let fail = true;
  const store: Store = {
    ...plain,
    async set(key, doc) {
      if (fail) {
        fail = false;
        throw new Error("disk full");
      }
      await plain.set(key, doc);
    },
  };
  const m = await StoreMirror.open<{ n: number }>(store, (err) => errors.push((err as Error).message));
  m.set("a", { n: 1 });
  m.set("b", { n: 2 });
  await m.flush();
  assert.deepEqual(errors, ["disk full"]);
  assert.deepEqual(m.get("a"), { n: 1 }, "the map keeps what was set");
  assert.deepEqual(await plain.list(), ["b"]);
});

storeConformance("memory", async () => memoryStore());
