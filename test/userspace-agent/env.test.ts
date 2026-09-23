import { test } from "node:test";
import assert from "node:assert/strict";
import type { StepEnv } from "../../src/contracts/index.js";
import { buildEnvFor, noStorage, storageClient, type Rpc } from "../../src/userspace-agent/env.js";

interface Call {
  method: string;
  args: unknown;
}

/** An rpc that records every call and answers from a queue. */
function fakeRpc(replies: unknown[] = []): { rpc: Rpc; calls: Call[] } {
  const calls: Call[] = [];
  const rpc = (async (method: string, args?: unknown) => {
    calls.push({ method, args });
    return replies.shift() ?? null;
  }) as Rpc;
  return { rpc, calls };
}

test("storageClient sends the five store calls with the package and namespace", async () => {
  const { rpc, calls } = fakeRpc([{ a: 1 }, null, null, ["x", "y"], null]);
  const store = storageClient(rpc, "@alice/notes", "drafts");
  assert.deepEqual(await store.get("k"), { a: 1 });
  await store.set("k", { b: 2 });
  await store.delete("k");
  assert.deepEqual(await store.list("pre"), ["x", "y"]);
  await store.clear();
  assert.deepEqual(calls, [
    { method: "store.get", args: { package: "@alice/notes", namespace: "drafts", key: "k" } },
    { method: "store.set", args: { package: "@alice/notes", namespace: "drafts", key: "k", doc: { b: 2 } } },
    { method: "store.delete", args: { package: "@alice/notes", namespace: "drafts", key: "k" } },
    { method: "store.list", args: { package: "@alice/notes", namespace: "drafts", prefix: "pre" } },
    { method: "store.clear", args: { package: "@alice/notes", namespace: "drafts" } },
  ]);
});

test("a null answer to get becomes undefined, and no namespace stays undefined", async () => {
  const { rpc, calls } = fakeRpc([null]);
  const store = storageClient(rpc, "@alice/notes");
  assert.equal(await store.get("missing"), undefined);
  assert.deepEqual(calls[0], { method: "store.get", args: { package: "@alice/notes", namespace: undefined, key: "missing" } });
});

test("buildEnvFor keeps the base env and binds storage to the package", async () => {
  const { rpc, calls } = fakeRpc([["one"]]);
  const base = { cwd: "/home", root: "/root", store: "/store", shared: "/shared", storage: noStorage } as unknown as StepEnv;
  const env = buildEnvFor(base, rpc, "@alice/notes");
  assert.equal(env.cwd, "/home");
  assert.equal(env.root, "/root");
  assert.deepEqual(await env.storage().list(), ["one"]);
  assert.deepEqual(calls[0], { method: "store.list", args: { package: "@alice/notes", namespace: undefined, prefix: undefined } });
  assert.throws(() => base.storage(), /storage\(\) needs the package that runs/);
});
