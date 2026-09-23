import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { findPackage } from "../dist/src/host/store.js";
import { PendingCalls } from "../dist/src/lib/rpc-frames.js";
import { connectRpcSocket, RpcSocketServer } from "../dist/src/lib/ndjson-socket.js";
import { ProcessHandle } from "../dist/src/sandbox/handle.js";

test("package discovery validates manifests before presenting them to callers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "thetis-manifest-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "broken"));
  await writeFile(join(root, "broken", "package.json"), JSON.stringify({ name: "@thetis/broken", version: "1", main: 42, thetis: { type: "host" } }));
  let inspected = false;
  assert.equal(findPackage(() => { inspected = true; return true; }, [root]), undefined);
  assert.equal(inspected, false);
});

test("malformed reply envelopes reject and cancel only their own call", async () => {
  for (const fields of [{}, { error: { message: "bad" } }, { error: "bad", code: 5 }, { event: "a", result: "b" }]) {
    const pending = new PendingCalls("t");
    let cancelled = 0;
    let cleaned = 0;
    const bad = pending.open({ cancel() { cancelled++; }, cleanup() { cleaned++; } });
    const good = pending.open();
    const rejected = assert.rejects(bad.result, { code: "invalid" });
    assert.doesNotThrow(() => pending.receive({ id: bad.id, ...fields }));
    await rejected;
    pending.receive({ id: good.id, result: { future: [1, { media: true }] }, extension: true });
    assert.deepEqual(await good.result, { future: [1, { media: true }] });
    assert.equal(cancelled, 1);
    assert.equal(cleaned, 1);
  }
});

test("an agent RPC with a malformed method is rejected before invoking the kernel", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  const sent = [];
  child.stdin.on("data", (chunk) => sent.push(JSON.parse(String(chunk))));
  let invoked = false;
  const handle = new ProcessHandle(child, { id: "alice" }, async () => { invoked = true; return null; }, { requestTimeoutMs: 1000, log() {} });
  child.stdout.write(JSON.stringify({ rpc: "p1", method: { invalid: true }, args: { arbitrary: [1, 2] } }) + "\n");
  await new Promise((done) => setImmediate(done));
  assert.equal(invoked, false);
  assert.equal(sent[0]?.rpcResult, "p1");
  assert.equal(sent[0]?.code, "invalid");
  child.emit("exit", 0);
  await handle.gone;
});

test("socket requests validate their method while leaving payload validation to the handler", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "thetis-rpc-schema-"));
  const path = join(root, "control.sock");
  const methods = [];
  const server = new RpcSocketServer(path, async (method, args) => { methods.push(method); return args; });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  await server.listen();
  const client = await connectRpcSocket(path);
  t.after(() => client?.close());
  await assert.rejects(client.call({ invalid: true }, {}), { code: "invalid" });
  const payload = [{ future: { mediaType: "video/future", options: null } }];
  assert.deepEqual(await client.call("future.operation", payload), payload);
  assert.deepEqual(methods, ["future.operation"]);
});
