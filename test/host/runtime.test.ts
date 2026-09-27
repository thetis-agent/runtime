import { FileAssetStore } from "../../src/lib/assets.js";
import { contentText } from "@thetis/runtime/lib/content";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createKernel, defaultConfig, T, type Fences } from "../../src/index.js";
import { memoryStore } from "../../src/lib/store.js";
import { cancelWhy } from "../../src/lib/error.js";

test("the public runtime can boot with injected adapters and no installed extensions", async () => {
  const home = mkdtempSync(join(tmpdir(), "thetis-runtime-"));
  const config = defaultConfig(home, join(home, "empty-installation"));
  config.systemPackages = {};
  config.storage.driver = "@test/not-installed";
  const requests: string[] = [];
  const closed: (string | undefined)[] = [];
  const fences: Fences = {
    async handle() { throw new Error("No userspace process is needed for an empty pipeline"); },
    async request(_userspace, operation) { requests.push(operation); return undefined; },
    async close(user) { closed.push(user); },
  };
  const store = memoryStore();
  const assetStore = new FileAssetStore(join(home, "injected-assets"));
  const hosts = { async call() { return "injected host"; }, selfExports: () => [] };

  try {
    const kernel = await createKernel(config, (container) => {
      container.bind(T.store, () => store);
      container.bind(T.assetStore, () => assetStore);
      container.bind(T.fences, () => fences);
      container.bind(T.hosts, () => hosts);
      container.bind(T.log, () => () => {});
      container.bind(T.fence, () => { throw new Error("The default process adapter must not be resolved"); });
    });
    try {
      assert.equal(kernel.store, store);
      assert.equal(kernel.container.get(T.assetStore), assetStore);
      assert.equal(kernel.fences, fences);
      assert.equal(kernel.hosts, hosts);
      kernel.users.create("alice");
      const session = kernel.sessions.create("alice");
      const events = [];
      for await (const event of kernel.sessions.send("alice", session.id, "hello")) events.push(event);
      assert.equal(events[0].type, "turn.start");
      assert.equal(events.at(-1)?.type, "turn.end");
      assert.ok(!events.some((event) => event.type === "error"));
      assert.equal(contentText(kernel.sessions.inspect("alice", session.id).conversation[0].content), "hello");
      assert.deepEqual(requests, []);
      const asset = await kernel.assets.put("alice", { mediaType: "image/png", data: "AP8q" });
      assert.equal((await kernel.assets.read("alice", asset.id)).data, "AP8q");
      await kernel.removeUser("alice");
      await assert.rejects(kernel.assets.read("alice", asset.id), { code: "not-found" });
    } finally {
      await kernel.shutdown();
    }
    assert.deepEqual(closed, ["alice", undefined]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * The 2026-09-25 loss: a restart closed the fences under a running turn and the process exited before the
 * runner's closing save. Shutdown now cancels every running turn as a restart and waits for its save first.
 */
test("shutdown cancels every running turn as a restart and waits for its closing save before any fence closes", async () => {
  const home = mkdtempSync(join(tmpdir(), "thetis-runtime-"));
  const config = defaultConfig(home, join(home, "empty-installation"));
  config.systemPackages = {};
  const order: string[] = [];
  const fences: Fences = {
    async handle() { throw new Error("not needed"); },
    async request() { return undefined; },
    async close(user) { order.push(`close ${user ?? "all"}`); },
  };
  const runner = {
    async runTurn(_us: unknown, session: { id: string }, _input: unknown, emit: (e: unknown) => void, signal: AbortSignal) {
      emit({ type: "turn.start", turn: "t1", session: session.id });
      await new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true }));
      await new Promise((r) => setTimeout(r, 10));
      order.push(`saved ${cancelWhy(signal)}`);
      emit({ type: "turn.end", turn: "t1", session: session.id });
      return session;
    },
  };
  try {
    const kernel = await createKernel(config, (c) => {
      c.bind(T.store, () => memoryStore());
      c.bind(T.assetStore, () => new FileAssetStore(join(home, "assets")));
      c.bind(T.fences, () => fences);
      c.bind(T.log, () => () => {});
      c.bind(T.runner, () => runner as never);
    });
    kernel.users.create("alice");
    const session = kernel.sessions.create("alice");
    const turn = (async () => { for await (const _ of kernel.sessions.send("alice", session.id, "long work")) void _; })();
    await new Promise((r) => setTimeout(r, 5));
    await kernel.shutdown();
    await turn;
    assert.deepEqual(order, ["saved restart", "close all"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
